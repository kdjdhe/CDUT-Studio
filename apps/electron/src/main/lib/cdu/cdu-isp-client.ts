/**
 * CDU ISP 学生综合服务平台客户端（xsswzx.cdu.edu.cn，经典 ASP 服务端渲染）
 *
 * 职责：
 *   - 经 persist:cdu-zone 分区进入 ISP（GET 入口 + follow redirects，CAS TGT 自动换票）；
 *   - 从 webindex.asp 外壳菜单抠出 44 位页面 token（菜单明文携带，无需破解生成逻辑）；
 *   - 调用纯函数解析器（cdu-isp-parsers.ts）产出结构化数据；
 *   - 编码容错：部分页面 content-type 不带 charset 且站点 GBK/UTF-8 混杂，按响应头 → meta 逐级嗅探。
 *
 * 范围声明（如实标注，不做过度承诺）：
 *   - 仅 GET 只读解析；ISP 无 CSRF token 且 token 走 URL，绝不在客户端构造任何写操作；
 *   - 站点会话靠 30s iframe 自续，本客户端仅在用户主动拉取时访问，不做高频保活。
 */

import { session } from 'electron'
import type { CduIspData } from '@profer/shared'
import { parseBooks, parseFamily, parseNotices, parseScore } from './cdu-isp-parsers'
import { CDU_SESSION_PARTITION } from './cdu-auth-manager'
import { getCachedCduData, setCachedCduData } from './cdu-cache'

/** ISP 站点根 */
const CDU_ISP_BASE = 'https://xsswzx.cdu.edu.cn'
/** ISP 学生端入口（经它会走完整 CAS 换票握手） */
const CDU_ISP_ENTRY = `${CDU_ISP_BASE}/ispstu/main`
/** 外壳页（全部菜单 + token 明文） */
const CDU_ISP_SHELL = `${CDU_ISP_BASE}/ispstu/com_user/webindex.asp`
/** 30 秒自我刷新的保活空页 */
const CDU_ISP_KEEPALIVE = `${CDU_ISP_BASE}/ispstu/com_user/sessionKeeper.asp`

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 20_000

/** ISP 聚合缓存有效期（30 分钟）：素质分/图书等日级变化数据 */
const ISP_CACHE_TTL_MS = 30 * 60 * 1000

/** 统一认证已失效（ISP 页面被重定向回 CAS 登录页）专用错误 */
export class CduCasExpiredError extends Error {
  constructor() {
    super('统一认证会话已过期，请退出 CDU 专区后重新登录')
    this.name = 'CduCasExpiredError'
  }
}

/** 编码嗅探解码：响应头 charset → 页面 meta charset → UTF-8，失败回退 GBK */
async function fetchDecodedText(ses: Electron.Session, url: string): Promise<string> {
  const response = await ses.fetch(url, { redirect: 'follow' })
  const buffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') ?? ''
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buffer.slice(0, 2048))
    charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase()
  }
  const decodeWith = (enc: string): string => {
    try {
      return new TextDecoder(enc).decode(buffer)
    } catch {
      return new TextDecoder('utf-8').decode(buffer)
    }
  }
  if (charset?.includes('gb')) {
    return decodeWith('gbk')
  }
  const utf8Text = decodeWith('utf-8')
  // UTF-8 解出大量替换符说明实际是 GBK
  if ((utf8Text.match(/\uFFFD/g) ?? []).length > 8) {
    return decodeWith('gbk')
  }
  return utf8Text
}

export class CduIspClient {
  /** 带超时的分区 fetch + 编码嗅探解码 */
  private async fetchPage(ses: Electron.Session, url: string): Promise<string> {
    return await Promise.race([
      fetchDecodedText(ses, url),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('ISP 请求超时，请检查校园网/VPN 连接')), REQUEST_TIMEOUT_MS)
      }),
    ])
  }

  /** CAS 登录页特征判定（Electron fetch 的 response.url 恒为空，只能看内容） */
  private looksLikeCasPage(html: string): boolean {
    return html.includes('login-page-flowkey') || html.includes('统一身份认证平台')
  }

  /** 进入 ISP（CAS 换票）并从外壳页抠出页面 token */
  private async ensureToken(ses: Electron.Session): Promise<string> {
    // 1. 走入口完成 CAS 换票握手（TGT 有效时亚秒级无感）
    const entryHtml = await this.fetchPage(ses, CDU_ISP_ENTRY)
    if (this.looksLikeCasPage(entryHtml)) {
      throw new CduCasExpiredError()
    }
    // 2. 外壳页抠 token（stushow.asp?user_no=... / affairs_my.asp?id=...）
    const shellHtml = await this.fetchPage(ses, CDU_ISP_SHELL)
    const token = /[?&](?:id|user_no)=([0-9a-f]{40,50})/.exec(shellHtml)?.[1]
    if (!token) {
      throw new Error('未能从 ISP 外壳页取得页面令牌（站点结构可能已变更）')
    }
    return token
  }

  /**
   * 一站式聚合：通知 + 素质分 + 图书借阅 + 困难认定。
   * TTL 内直接命中两级缓存（内存/磁盘），force=true（用户点刷新）绕过。
   * 单页失败不阻断整体，错误收敛进 partialErrors。
   */
  public async fetchOverview(force = false): Promise<CduIspData> {
    if (!force) {
      const cached = getCachedCduData<CduIspData>('isp', ISP_CACHE_TTL_MS)
      if (cached) return cached
    }
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    const token = await this.ensureToken(ses)
    const partialErrors: string[] = []

    // 解析器为纯函数，同步执行；异常收敛为 partialErrors
    const collect = <T>(label: string, task: () => T, fallback: T): T => {
      try {
        return task()
      } catch (error) {
        partialErrors.push(`${label}解析失败：${error instanceof Error ? error.message : String(error)}`)
        return fallback
      }
    }

    const withTimeout = <T>(task: Promise<T>): Promise<T> =>
      Promise.race([
        task,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('请求超时')), REQUEST_TIMEOUT_MS)
        }),
      ])

    const [noticesHtml, scoreHtml, booksHtml, familyHtml] = await Promise.all([
      withTimeout(this.fetchPage(ses, `${CDU_ISP_BASE}/ispstu/com_user/main.asp`)),
      withTimeout(this.fetchPage(ses, `${CDU_ISP_BASE}/ispstu/com_user/my_score.asp?id=${token}`)),
      withTimeout(this.fetchPage(ses, `${CDU_ISP_BASE}/ispstu/com_user/stu_tsjy.asp`)),
      withTimeout(this.fetchPage(ses, `${CDU_ISP_BASE}/ispstu/com_user/pc_family.asp`)),
    ])

    if (this.looksLikeCasPage(noticesHtml) || this.looksLikeCasPage(scoreHtml)) {
      throw new CduCasExpiredError()
    }

    const notices = collect('首页通知', () => parseNotices(noticesHtml), [])
    const score = collect('素质分', () => {
      const parsed = parseScore(scoreHtml)
      return parsed.months.length > 0 ? parsed : null
    }, null)
    const books = collect('图书借阅', () => parseBooks(booksHtml), [])
    const family = collect('困难认定', () => {
      const parsed = parseFamily(familyHtml)
      return parsed.tasks.length > 0 || parsed.assessments.length > 0 ? parsed : null
    }, null)

    // 顺带碰一下保活页（站点自身 30s 刷新，这里仅在用户主动拉取时补一次）
    try {
      await withTimeout(this.fetchPage(ses, CDU_ISP_KEEPALIVE))
    } catch {
      // 保活失败不阻断数据返回
    }

    const data: CduIspData = {
      fetchedAt: Date.now(),
      tokenFound: true,
      notices,
      score,
      books,
      family,
      partialErrors,
    }
    setCachedCduData('isp', data)
    return data
  }
}

export const cduIspClient = new CduIspClient()
