/**
 * CDU 校园网环境判定
 *
 * 为什么需要这个模块（2026-10 四份 HAR 实抓结论）：
 *
 *   1. CAS 入口 id.cdu.edu.cn 对公网完全开放 —— 校外访问同样 302，
 *      所以「能不能打开统一身份认证」**不能**作为内外网判据；
 *   2. 校外访问业务系统时，网关不返回 403 状态码，而是用 HTTP 200 返回一个
 *      伪装成「页面正在修复中，请稍后重试」的页面（正文里才写着 403 Forbidden nginx），
 *      因此**不能看状态码，必须读正文**；
 *   3. 该拦截页有多个变体（szjw 版带 403 Forbidden 字样，xsswzx 版没有），
 *      长度也不固定，所以指纹只能取稳定标记：`id="solt"` 与「页面正在修复中」；
 *   4. 未登录时业务路径返回 302 跳 CAS（这是正常流程，不是被拦）。
 *
 * 结论：判定必须发生在**登录之后**，并且针对真实业务端点，而不是探活 ping。
 */

import type { Session } from 'electron'
import type { CduNetState } from '@profer/shared'

/**
 * 校外拦截页稳定标记。
 *
 * 实测两个变体（13046 / 12975 字节）都同时包含这两处，而正常业务页不含，
 * 因此用「命中任意一个」作为判定，避免绑定长度或 403 字样。
 */
export const CDU_BLOCK_PAGE_MARKERS = ['id="solt"', '页面正在修复中'] as const

/**
 * 登录后判定用的业务端点：数智教务当前学年学期查询。
 *
 * 选它的理由：返回体小（JSON）、无副作用、登录后必然有权限；
 * 校外被拦时会被网关替换成拦截页，校内（含经隧道）返回正常 JSON。
 */
const CDU_PROBE_URL = 'https://szjw.cdu.edu.cn/admin/api/jcsj/xnxq/getCurrentXnxq'

const DEFAULT_PROBE_TIMEOUT_MS = 8_000

export interface CduProbeResult {
  state: CduNetState
  /** HTTP 状态码；0 表示请求未完成（超时 / 连接失败） */
  status: number
  /** 供日志与排障的简短说明，不含任何凭据 */
  detail?: string
}

/** 正文是否为校外拦截页 */
export function isCduBlockPage(body: string): boolean {
  if (!body) return false
  return CDU_BLOCK_PAGE_MARKERS.some((marker) => body.includes(marker))
}

/**
 * 把一次业务响应归类成四态。
 *
 * 注意：302/303 归为 need-login 而不是 blocked —— 跳 CAS 是正常登录流程，
 * 把它当成「被限制」会给用户完全错误的提示。
 */
export function classifyCduResponse(input: {
  status: number
  contentType?: string
  body?: string
}): CduNetState {
  const { status } = input
  const contentType = input.contentType ?? ''
  const body = input.body ?? ''

  if (status === 0) return 'unreachable'
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    return 'need-login'
  }
  if (isCduBlockPage(body)) return 'blocked'

  if (status >= 200 && status < 300) {
    // 期望 JSON 的业务端点却返回 HTML：说明被中间层换掉了，保守判为受阻
    if (contentType.includes('text/html') && body.trimStart().startsWith('<')) return 'blocked'
    return 'ok'
  }

  return 'unreachable'
}

/**
 * 用指定分区会话探测当前网络环境。
 *
 * 必须传入 persist:cdu-zone 分区：判定结果依赖已登录的会话 Cookie，
 * 换成裸 fetch 会永远得到 need-login。
 */
export async function probeCduNetworkState(
  ses: Session,
  options: { timeoutMs?: number } = {},
): Promise<CduProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  let response: Response
  try {
    response = await ses.fetch(CDU_PROBE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
      },
      // 手动处理跳转，才能把 302 与「被拦截」区分开
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { state: 'unreachable', status: 0, detail: message.slice(0, 160) }
  }

  const contentType = response.headers.get('content-type') ?? ''
  let body = ''
  try {
    body = await response.text()
  } catch {
    // 拦截页可能没有可读正文；保持空串交由状态码与 contentType 判定
  }

  const state = classifyCduResponse({ status: response.status, contentType, body })
  return {
    state,
    status: response.status,
    detail: state === 'ok' ? undefined : `${contentType.split(';')[0] || 'no-content-type'}`,
  }
}
