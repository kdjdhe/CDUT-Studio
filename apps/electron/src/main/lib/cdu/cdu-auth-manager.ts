/**
 * CDU 专区（成都大学）特区账户认证管理器
 *
 * 职责：
 *   - 纯 HTTP 驱动成都大学统一身份认证（id.cdu.edu.cn，CAS 协议）登录数智教务（szjw.cdu.edu.cn）；
 *   - 会话 Cookie 物理隔离于 persist:cdu-zone 分区，与通用账户、CDUT 特区互不串扰；
 *   - 登录成功后抓取姓名画像（数智教务主框架页顶栏）与当前学年学期；
 *   - 每 10 分钟向教务 getCurrentRole 静默保活，检测到会话失效则标记 expired；
 *   - 加密持久化特区账户（仅密码字段经 token-crypto 加密）到 ~/.cdutai/cdu-account.json。
 *
 * 认证链路（来自 2026-10 实抓包分析，与前端 deploy.js 的 aesEncrypt 逻辑一致）：
 *   1. GET  szjw /admin/caslogin → 302 落到 CAS 登录页，页面内嵌
 *      execution 令牌（login-page-flowkey）与本次会话 AES 密钥（login-croypto）；
 *   2. findCaptchaCount 预检：连续失败计数 > 0 时 CAS 要求验证码，如实报错不强行提交；
 *   3. POST /login（form-urlencoded）：password = AES-128-ECB(明文密码, key=login-croypto)，
 *      croypto 原样回传，execution 一次性令牌随表单提交；
 *   4. 302 携 ST ticket 回落数智教务，会话 Cookie 自动落分区。
 *
 * MFA 二次验证（2026-10-12 起学校强制启用，抓包实拍协议）：
 *   密码正确时步骤 3 返回 200 二次认证页（含 sso-second/corpwechatQr 标记）而非 302，
 *   本模块自动跑企业微信扫码链路：loginid → qrgen（PNG 原样转发渲染进程）→
 *   scan 长轮询（挂起 ~24s，手机确认即返回 QRT 令牌）→ POST /login(type=corpwechatQr)
 *   → 302 ticket。用户唯一动作是在手机企业微信上点一次确认；
 *   二维码内容不做本地解码，短信/邮件通道因图形验证码对抗不自动化。
 *
 * 范围声明（如实标注，不做过度承诺）：
 *   - 本模块不主动嗅探、不解码 CAS Cookie；网络请求经由专属分区 Session 携带其自身 Cookie；
 *   - 「active」表示最近一次认证成功且保活心跳未检测到失效；
 *   - 暂不处理验证码/风控分支（首次登录无需验证码，连续失败才会触发）。
 */

import { session } from 'electron'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import type {
  CduAccountProfile,
  CduLoginInput,
  CduLoginResult,
  CduMfaQrPayload,
  CduSavedAccountSummary,
} from '@profer/shared'
import { getCduAccountPath } from '../config-paths'
import { encryptToken, decryptToken } from '../token-crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { onCduLogout } from './cdu-cache'

/** 成都大学统一身份认证（CAS）地址 */
const CDU_CAS_BASE = 'https://id.cdu.edu.cn'
/** 成都大学数智教务（正方系）地址，所有业务域挂载其下 */
const CDU_JW_BASE = 'https://szjw.cdu.edu.cn'
/** 教务 CAS 登录入口：经它会 302 到统一身份认证并绑定 service */
const CDU_CAS_ENTRY = `${CDU_JW_BASE}/admin/caslogin`

/** 特区账户专属隔离分区，与通用账户、CDUT 特区物理隔离 */
export const CDU_SESSION_PARTITION = 'persist:cdu-zone'

/** 心跳保活周期：10 分钟 */
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000

/** 单次网络请求超时（登录链路各步骤共用） */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * MFA 扫码长轮询单次挂起上限。CAS scan 接口实测挂起约 24s，
 * 客户端超时略长于服务器侧，避免竞态截断返回包。
 */
const MFA_POLL_TIMEOUT_MS = 30_000

/** MFA 扫码整体过期时间：超时后建议用户重新发起登录换新码 */
const MFA_SESSION_TIMEOUT_MS = 3 * 60_000

/** MFA 二维码阶段（进程内状态机，与渲染进程的展示态通过 IPC 同步） */
type MfaPhase = 'idle' | 'awaiting-qr' | 'polling' | 'completed'

/** MFA 流程运行时状态（同一时刻至多一个进行中的扫码会话） */
interface MfaRuntime {
  phase: MfaPhase
  /** CAS 二维码会话 ID（qrlogin/loginid 接口返回的 22 位一次性串） */
  loginId: string
  /** 二维码 PNG 的 dataURL（qrgen 原样转发，客户端不解码内容） */
  qrImage: string
  /** 密码验证通过后的第二次 execution（MFA 页内嵌，绑定已验密流程） */
  execution: string
  /** 触发本次 MFA 的登录输入（成功后需要用户名/记住选项落盘） */
  loginInput: CduLoginInput
  startedAt: number
  cancelled: boolean
  /** 当前挂起中的 scan 长轮询；取消/重新登录时必须真正 abort */
  pollController?: AbortController
}

/** 本地持久化结构（密码字段为密文） */
interface StoredCduAccount {
  studentId: string
  studentName?: string
  passwordEncrypted?: string
  rememberPassword?: boolean
  lastLoginAt?: number
}

/** CAS 登录页内嵌的流程凭据 */
interface CasPageCredentials {
  /** 一次性流程令牌（页面元素 login-page-flowkey） */
  execution: string
  /** 本次会话的密码加密密钥，Base64 编码的 16 字节 AES-128 密钥（login-croypto） */
  croypto: string
}

/** 从 CAS 登录页 HTML 解析 execution 与 croypto */
function parseCasCredentials(html: string): CasPageCredentials {
  const execution = html.match(/id="login-page-flowkey"[^>]*>([^<]+)</)?.[1]?.trim()
  const croypto = html.match(/id="login-croypto"[^>]*>([^<]+)</)?.[1]?.trim()
  if (!execution || !croypto) {
    throw new Error('统一身份认证页面解析失败：未取得流程令牌（站点结构可能已变更）')
  }
  return { execution, croypto }
}

/**
 * CDU 统一身份认证密码加密：AES-128-ECB + PKCS7，密钥为页面下发的 login-croypto（Base64 编码 16 字节）。
 * 已用真实抓包密文逆向验证（deploy.js 的 aesEncrypt 同款模式）。
 */
function encryptCduPassword(password: string, croyptoB64: string): string {
  const key = Buffer.from(croyptoB64, 'base64')
  if (key.length !== 16) {
    throw new Error('统一身份认证密钥长度异常，站点加密方案可能已变更')
  }
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64')
}

/** 从数智教务主框架页 HTML 抓取「姓名/学号」画像 */
function parseStudentNameFromAdminHtml(html: string): string | null {
  const matched = html.match(/class="block">\s*([^<]+?)\s*<em[^>]*>[^<]*<\/em>\s*(\d{4,})\s*<\/span>/)
  return matched?.[1]?.trim() ?? null
}

/**
 * 诊断辅助：从二维码 PNG 解码内容并输出到主进程日志（仅诊断，不参与登录逻辑）。
 * 手机端报 500 时，日志里的 redirect URL 是与浏览器成功案例对照的关键证据。
 */
function logMfaQrContent(png: Buffer): void {
  try {
    // pngjs/jsqr 仅诊断用，require 形式避免未用时的初始化开销
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PNG } = require('pngjs') as typeof import('pngjs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsQR = require('jsqr') as { default?: unknown } & ((...args: unknown[]) => { data?: string } | null)
    const decoded = PNG.sync.read(png)
    const decodeFn = (jsQR as { default?: unknown }).default ?? jsQR
    const result = (decodeFn as (...a: unknown[]) => { data?: string } | null)(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height)
    if (result?.data) {
      console.log(`[cdu-mfa] QR content: ${result.data}`)
    } else {
      console.log('[cdu-mfa] QR decode returned null (content unreadable)')
    }
  } catch (err) {
    console.log(`[cdu-mfa] QR decode unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * CAS /api/protected/* 接口的 CSRF 防护头（从 cas-login Angular 包逆向，已用真实抓包值验证）：
 *   csrf-key  = 32 位随机串（浏览器为 FingerprintJS 等混合的随机值，服务器只校验配对）
 *   csrf-value = md5( base64前半 + base64全串 + base64后半 )，其中 base64 = base64(csrf-key)
 * 算法还原自 main-es2015 bundle：`btoa(key)` 后按半长拼接再取 md5 hex。
 * 实测：key=wEfxpBNWekNJWO7cFOwUKvIFnelvhUqZ → value=5618a541db5ee194ba87018cb3ea1fb0 与抓包一致。
 */
function generateCduCasCsrfHeaders(): { 'csrf-key': string; 'csrf-value': string } {
  const random = randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 32).padEnd(32, '0')
  const b64 = Buffer.from(random, 'utf8').toString('base64')
  const mixed = b64.slice(0, Math.floor(b64.length / 2)) + b64 + b64.slice(Math.floor(b64.length / 2))
  const value = createHash('md5').update(mixed).digest('hex')
  return { 'csrf-key': random, 'csrf-value': value }
}

/** 设备指纹头：稳定随机 32 hex（安装级持久语义即可，服务器按"存在且一致"对待） */
function generateCduCasDeviceId(): string {
  return randomBytes(16).toString('hex')
}

export class CduAuthManager {
  private profile: CduAccountProfile = {
    studentId: '',
    studentName: '',
    status: 'disconnected',
  }

  private onStatusChangeCallback: ((profile: CduAccountProfile) => void) | null = null
  /** MFA 二维码更新回调（主进程向渲染进程推送阶段与图片） */
  private onMfaQrCallback: ((payload: CduMfaQrPayload) => void) | null = null
  private keepAliveTimer: NodeJS.Timeout | null = null
  private restoreStarted = false
  private mfa: MfaRuntime | null = null

  /** 绑定状态变更回调（主进程向渲染进程广播） */
  public setStatusCallback(cb: (profile: CduAccountProfile) => void): void {
    this.onStatusChangeCallback = cb
  }

  /** 绑定 MFA 二维码更新回调（渲染进程打开面板时接收阶段/图片推送） */
  public setMfaQrCallback(cb: (payload: CduMfaQrPayload) => void): void {
    this.onMfaQrCallback = cb
  }

  /** 当前 MFA 二维码快照（渲染进程打开面板/刷新时主动拉取） */
  public getMfaQrSnapshot(): CduMfaQrPayload {
    if (!this.mfa || this.mfa.phase === 'idle') {
      return { phase: 'idle', hint: '当前没有进行中的扫码验证' }
    }
    return {
      phase: this.mfa.phase,
      qrImage: this.mfa.phase === 'completed' ? undefined : this.mfa.qrImage,
      hint:
        this.mfa.phase === 'awaiting-qr'
          ? '请用企业微信扫描二维码，并在手机上确认登录'
          : this.mfa.phase === 'polling'
            ? '已在手机上确认，正在完成登录…'
            : '扫码验证已完成',
    }
  }

  /** 中止当前 MFA 流程（不广播状态），供取消/重新登录/登出复用 */
  private abortActiveMfa(): void {
    if (!this.mfa) return
    this.mfa.cancelled = true
    this.mfa.pollController?.abort()
    this.mfa = null
  }

  /** 用户取消扫码：终止主进程轮询并回到未登录态 */
  public cancelMfa(): void {
    this.abortActiveMfa()
    this.profile = { ...this.profile, status: 'disconnected' }
    this.emitStatus()
  }

  /** 获取当前特区账户快照 */
  public getProfile(): CduAccountProfile {
    return { ...this.profile }
  }

  /** 应用启动后首次查询时，尝试用持久化分区中的既有会话静默恢复登录态 */
  public async ensureSessionRestored(): Promise<void> {
    if (this.restoreStarted) return
    this.restoreStarted = true
    const stored = readJsonFileSafe<StoredCduAccount>(getCduAccountPath())
    if (!stored?.studentId) return
    this.profile = {
      studentId: stored.studentId,
      studentName: stored.studentName ?? '',
      status: 'disconnected',
      lastLoginAt: stored.lastLoginAt,
    }
    const active = await this.verifyJwSession()
    if (active) {
      this.profile = {
        ...this.profile,
        status: 'active',
        lastActiveAt: Date.now(),
      }
      this.emitStatus()
      this.startKeepAlive()
    }
  }

  /**
   * 登录：纯 HTTP 走通 CAS → 数智教务全链路
   *
   * 注意：Electron session.fetch 的 response.url 恒为空串（已知怪癖），
   * 成败判定一律基于响应内容与教务会话探针，绝不依赖重定向最终 URL。
   *
   * 失败时返回 { success: false, error }，绝不伪装成功；状态机只落在
   * disconnected（未登录/失败）与 active（认证成功且心跳正常）。
   */
  public async login(input: CduLoginInput): Promise<CduLoginResult> {
    const username = input.username.trim()
    if (!username || !input.password) {
      return { success: false, error: '请输入学工号与密码' }
    }

    // 上一次扫码可能还挂着长轮询或最终 POST；先真正中止，避免旧会话卡住新登录
    this.abortActiveMfa()

    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    // 每次主动登录都从干净 CAS 会话开始：清掉上一次失败留下的 Cookie / 挂起连接，
    // 否则旧 MFA 会话可能让新的扫码确认投递到已废弃的请求上。
    try {
      await ses.clearStorageData({ storages: ['cookies'] })
      await ses.closeAllConnections()
    } catch {
      // 清理失败不阻断登录，继续走正常 CAS 流程
    }

    this.profile = { ...this.profile, studentId: username, status: 'connecting' }
    this.emitStatus()

    try {
      // 1. 打开教务 CAS 入口，跟随重定向落到统一身份认证登录页（service 自动绑定）
      const pageResponse = await this.fetchWithTimeout(ses, CDU_CAS_ENTRY, { redirect: 'follow' }, 'CAS 登录页')
      const pageHtml = await pageResponse.text()
      console.log(`[cdu-auth] CAS 登录页 http=${pageResponse.status} html=${pageHtml.length}`)
      if (!pageHtml.includes('login-page-flowkey')) {
        throw new Error('统一身份认证登录页加载异常（未取得流程令牌），请稍后重试')
      }
      const { execution, croypto } = parseCasCredentials(pageHtml)

      // 2. 验证码预检：连续登录失败达到阈值后 CAS 会强制验证码，此时如实终止；
      //    预检接口本身不可用（401 等）时静默放行，以实际提交结果为准
      await this.ensureNoCaptchaRequired(ses, username)

      // 3. 提交登录表单（密码 AES-128-ECB 加密；POST 到 CAS 固定路径 /login，与抓包一致）
      const form = new URLSearchParams({
        username,
        type: 'UsernamePassword',
        _eventId: 'submit',
        geolocation: '',
        execution,
        captcha_code: '',
        croypto,
        password: encryptCduPassword(input.password, croypto),
        captcha_payload: '',
      })
      const postResponse = await this.fetchWithTimeout(ses, `${CDU_CAS_BASE}/login`, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: `${CDU_CAS_BASE}/login`,
        },
        body: form.toString(),
      }, '密码提交')
      const landedHtml = await postResponse.text()

      // 2026-10-12 起学校强制 MFA：密码正确时 CAS 返回 200 二次认证页（同样内嵌
      // login-page-flowkey，但带 sso-second / corpwechatQr 标记）。三种着陆形态：
      //   a) 重定向成功（Electron fetch 落地页无 flowkey）→ 走既有成功路径
      //   b) MFA 二次认证页（含 sso-second / corpwechatQr 标记）→ 进入扫码状态机
      //   c) 普通登录页（无 MFA 标记）→ 密码错误 / 触发验证码 / 账号锁定
      const hasFlowkey = landedHtml.includes('login-page-flowkey')
      const isMfaPage = hasFlowkey && (landedHtml.includes('sso-second') || landedHtml.includes('corpwechatQr'))
      console.log(`[cdu-auth] 密码提交 http=${postResponse.status} flowkey=${hasFlowkey} mfa=${isMfaPage} html=${landedHtml.length}`)
      if (hasFlowkey) {
        if (isMfaPage) {
          const mfaExecution = parseCasCredentials(landedHtml).execution
          // 后台启动扫码状态机；立即返回 mfaRequired，由渲染进程打开二维码面板
          void this.startMfaQrFlow(mfaExecution, input)
          this.profile = { ...this.profile, status: 'connecting' }
          this.emitStatus()
          return { success: false, mfaRequired: true, error: '需要二次验证：请用企业微信扫码' }
        }
        await this.ensureNoCaptchaRequired(ses, username)
        const errorCode = landedHtml.match(/id="login-error-code"[^>]*>([^<]*)</)?.[1]
        throw new Error(
          `登录失败：学工号或密码错误${errorCode ? `（错误码 ${errorCode}）` : ''}，连续失败会触发验证码保护`,
        )
      }

      // 4. 校验教务会话（角色 + 当前学年学期）——权威判定
      const roleJson = await this.fetchCurrentRole(ses)
      const data = roleJson?.data
      console.log(`[cdu-auth] 教务角色探针 ret=${roleJson?.ret ?? 'null'} role=${data?.currentRoleId ?? 'none'}`)
      if (!data || data.currentRoleId !== 'xs') {
        throw new Error('教务会话建立失败：未取得学生角色，请确认使用学生账号')
      }

      // 5. 抓取姓名画像：优先用登录落地页（即教务主框架），失败再补一次 /admin
      const studentName =
        parseStudentNameFromAdminHtml(landedHtml) ??
        (await this.fetchStudentName(ses)) ??
        data.currentUserName ??
        username

      this.profile = {
        studentId: username,
        studentName,
        role: data.currentRoleId,
        semester: data.dataXnxq,
        status: 'active',
        rememberPassword: input.rememberPassword,
        lastLoginAt: Date.now(),
        lastActiveAt: Date.now(),
      }
      this.persistAccount(input.password, input.rememberPassword === true)
      this.emitStatus()
      this.startKeepAlive()

      return { success: true, profile: this.getProfile() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[cdu-auth] 登录失败:', message)
      this.profile = { ...this.profile, status: 'disconnected' }
      this.emitStatus()
      return { success: false, error: message }
    }
  }

  /** 退出登录：清空分区 Cookie、删除本地凭据与数据缓存并停掉心跳 */
  public async logout(): Promise<void> {
    this.abortActiveMfa()
    this.stopKeepAlive()
    try {
      const ses = session.fromPartition(CDU_SESSION_PARTITION)
      await ses.clearStorageData({ storages: ['cookies'] })
    } catch {
      // 分区清理失败不阻断本地状态重置
    }
    // 保留缓存文件作为未登录可看的离线快照（课表等低敏数据），仅清进程内存层
    onCduLogout()
    const accountPath = getCduAccountPath()
    if (existsSync(accountPath)) {
      try {
        unlinkSync(accountPath)
      } catch {
        // 文件占用时忽略，下次登录覆盖
      }
    }
    this.profile = { studentId: '', studentName: '', status: 'disconnected' }
    this.emitStatus()
  }

  /** 查询本地已保存账户摘要（供登录卡一键填充；密码仅在勾选记住时返回） */
  public getSavedAccount(): CduSavedAccountSummary {
    const stored = readJsonFileSafe<StoredCduAccount>(getCduAccountPath())
    if (!stored?.studentId) {
      return { hasSaved: false }
    }
    let savedPassword: string | undefined
    if (stored.rememberPassword && stored.passwordEncrypted) {
      try {
        savedPassword = decryptToken(stored.passwordEncrypted)
      } catch {
        savedPassword = undefined
      }
    }
    return {
      hasSaved: true,
      studentId: stored.studentId,
      studentName: stored.studentName,
      rememberPassword: stored.rememberPassword === true,
      savedPassword,
    }
  }

  // ===== 内部实现 =====

  // ===== MFA 企业微信扫码二次验证（2026-10-12 抓包协议） =====
  //
  // 流程（与真实抓包一一对应）：
  //   1. GET  /api/protected/qrlogin/loginid → 一次性 22 位 loginid
  //   2. GET  /api/public/qrlogin/qrgen/{loginid}/corpwechatQr → 250×250 PNG 二维码
  //   3. GET  /api/protected/qrlogin/scan/{loginid} → 长轮询挂起 ~24s；
  //      手机确认瞬间返回 "QRT-100-<随机>#<loginid>"；超时则原样重发
  //   4. POST /login（type=corpwechatQr, username=QRT 令牌, execution=MFA 页令牌）→ 302 ticket
  //
  // 二维码对客户端是不透明图片：原样 base64 转发给渲染进程渲染，扫码识别全部由手机侧完成。

  /** MFA 全流程：取码 → 展示 → 长轮询 → 提交 QRT → 建立教务会话（后台运行，不阻塞 login 返回） */
  private async startMfaQrFlow(execution: string, input: CduLoginInput): Promise<void> {
    this.mfa = {
      phase: 'awaiting-qr',
      loginId: '',
      qrImage: '',
      execution,
      loginInput: input,
      startedAt: Date.now(),
      cancelled: false,
    }
    const runtime = this.mfa
    try {
      const ses = session.fromPartition(CDU_SESSION_PARTITION)
      // /api/protected/* 需要 CSRF 双头 + 设备指纹（缺失时接口 401 Unauthorized，
      // 这正是之前 loginid 失败、二维码变成 [object Object] 的根因）
      const referer = { referer: `${CDU_CAS_BASE}/login` }
      const csrfHeaders = generateCduCasCsrfHeaders()
      const deviceId = generateCduCasDeviceId()
      const apiHeaders = {
        ...referer,
        accept: 'application/json, text/plain, */*',
        ...csrfHeaders,
        'device-id': deviceId,
        'sid-language': 'zh_CN',
      }

      // 1. 申请二维码会话 ID
      // 注意：loginid 响应的 data 必须是纯字符串。曾出现过接口返回错误包
      // （data 为对象/空），旧代码未校验类型，拼 URL 后变成 "[object Object]"，
      // 生成的二维码手机打开即 500 —— 故此处严格校验并记录原始响应体。
      const loginIdResp = await this.fetchWithTimeout(ses, `${CDU_CAS_BASE}/api/protected/qrlogin/loginid?${Date.now()}`, {
        headers: apiHeaders,
      }, 'MFA loginid')
      const loginIdRaw = await loginIdResp.text()
      let loginIdJson: { code?: number; message?: string; data?: unknown }
      try {
        loginIdJson = JSON.parse(loginIdRaw) as { code?: number; message?: string; data?: unknown }
      } catch {
        throw new Error(`二次验证初始化失败：loginid 接口返回非 JSON（HTTP ${loginIdResp.status}）`)
      }
      const loginId = typeof loginIdJson?.data === 'string' ? loginIdJson.data : ''
      console.log(`[cdu-mfa] loginid resp: http=${loginIdResp.status} code=${loginIdJson?.code} message=${loginIdJson?.message ?? ''} data=${typeof loginIdJson?.data === 'string' ? loginIdJson.data : JSON.stringify(loginIdJson?.data)}`)
      if (!loginId) {
        throw new Error(
          `二次验证初始化失败：未取得有效二维码会话（code=${loginIdJson?.code ?? '?'} message=${loginIdJson?.message ?? loginIdRaw.slice(0, 80)}）。请稍后重试`,
        )
      }
      if (this.mfa !== runtime) return
      runtime.loginId = loginId

      // 2. 取二维码 PNG（原样转 dataURL 给渲染进程）
      const qrResp = await this.fetchWithTimeout(ses, `${CDU_CAS_BASE}/api/public/qrlogin/qrgen/${encodeURIComponent(loginId)}/corpwechatQr`, { headers: apiHeaders }, 'MFA 二维码')
      const qrBuffer = Buffer.from(await qrResp.arrayBuffer())
      if (this.mfa !== runtime) return
      runtime.qrImage = `data:image/png;base64,${qrBuffer.toString('base64')}`
      console.log(`[cdu-mfa] qrgen http=${qrResp.status} bytes=${qrBuffer.length}`)
      // 诊断日志：解码二维码内容（redirect URL 带 t=票据），与浏览器抓包对照
      // QR 内容形如 https://id.cdu.edu.cn/api/public/redirect/{loginid}/corpwechatQr?t={32hex}
      logMfaQrContent(qrBuffer)
      this.emitMfaQr()

      // 3. 循环长轮询直至手机确认 / 用户取消 / 整体超时
      const qrt = await this.pollMfaQr(ses, loginId, apiHeaders, runtime)
      if (!qrt || this.mfa !== runtime) return // 取消 / 超时（emit 已处理）

      // 4. 提交 QRT 完成登录（# 必须转义为 %23，与浏览器行为一致）
      runtime.phase = 'polling'
      this.emitMfaQr()
      const form = new URLSearchParams({
        _eventId: 'submit',
        type: 'corpwechatQr',
        execution: runtime.execution,
        geolocation: '',
        username: qrt,
      })
      const finalResp = await this.fetchWithTimeout(ses, `${CDU_CAS_BASE}/login`, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // 不要加 Origin：Electron ses.fetch 会把带 Origin 的请求当成 CORS 请求，
          // CAS 成功后 302 到 szjw 时目标页没有 Access-Control-Allow-Origin，
          // 会直接 net::ERR_FAILED。referer + accept 已足够，且不触发 CORS。
          referer: `${CDU_CAS_BASE}/login`,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        body: form.toString(),
      }, 'MFA QRT 提交')
      const landedHtml = await finalResp.text()
      if (this.mfa !== runtime) return
      const hasFlowkey = landedHtml.includes('login-page-flowkey')
      console.log(`[cdu-mfa] QRT 提交 http=${finalResp.status} flowkey=${hasFlowkey} html=${landedHtml.length}`)
      if (hasFlowkey) {
        throw new Error('扫码验证未生效（CAS 未签发票据），请重新登录')
      }

      // 5. 与密码直登路径共用收尾：校验教务会话 + 抓取画像 + 落盘
      runtime.phase = 'completed'
      this.emitMfaQr()
      await this.finalizeLoginSuccess(input)
      if (this.mfa === runtime) this.mfa = null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const wasCancelled = runtime.cancelled
      runtime.pollController?.abort()
      if (this.mfa === runtime) this.mfa = null
      if (wasCancelled) return
      console.error('[cdu-mfa] 流程失败:', message)
      this.profile = { ...this.profile, status: 'disconnected' }
      this.emitStatus()
      // 失败原因通过 MFA 回调如实暴露（phase 归 idle、hint 携带错误文案）
      this.onMfaQrCallback?.({ phase: 'idle', hint: message })
    }
  }

  /**
   * 长轮询循环：单次挂起 30s，返回 QRT 令牌；null = 用户取消或整体超时。
   * 关键：超时必须用 AbortController 真正中止底层请求——若只放弃 Promise 而让旧
   * 请求继续挂在服务器，手机确认事件可能投递给已被丢弃的旧 poll，新 poll 永远
   * 收不到 QRT（与「浏览器成功、客户端 500」的故障现象吻合）。
   */
  private async pollMfaQr(
    ses: Electron.Session,
    loginId: string,
    apiHeaders: Record<string, string>,
    runtime: MfaRuntime,
  ): Promise<string | null> {
    while (this.mfa === runtime && !runtime.cancelled) {
      if (Date.now() - runtime.startedAt > MFA_SESSION_TIMEOUT_MS) {
        if (this.mfa === runtime) this.mfa = null
        this.profile = { ...this.profile, status: 'disconnected' }
        this.emitStatus()
        this.onMfaQrCallback?.({ phase: 'idle', hint: '二维码已超时，请重新登录获取新码' })
        return null
      }
      const controller = new AbortController()
      runtime.pollController = controller
      const timer = setTimeout(() => controller.abort(), MFA_POLL_TIMEOUT_MS)
      try {
        const resp = await ses.fetch(`${CDU_CAS_BASE}/api/protected/qrlogin/scan/${encodeURIComponent(loginId)}?${Date.now()}`, {
          headers: apiHeaders,
          signal: controller.signal,
        })
        if (this.mfa !== runtime || runtime.cancelled) return null
        const json = (await resp.json()) as { code?: number; message?: string; data?: string }
        if (!json?.data?.startsWith('QRT-')) {
          // 非 QRT 响应（等待中/服务器异常）记入日志，便于诊断手机端 500 等问题
          console.log(`[cdu-mfa] scan poll: code=${json?.code} message=${json?.message ?? ''} data=${json?.data ?? '(empty)'}`)
        }
        // QRT-xxx-xxx#loginid = 手机已确认；其余（等待/超时）继续下一轮
        if (json?.data && json.data.startsWith('QRT-')) {
          console.log('[cdu-mfa] 手机已确认，收到 QRT')
          return json.data
        }
      } catch {
        // 单轮网络抖动/超时中止不终止整体流程，稍作间隔后重试
        await new Promise((resolve) => setTimeout(resolve, 1500))
      } finally {
        clearTimeout(timer)
        if (runtime.pollController === controller) runtime.pollController = undefined
      }
    }
    return null
  }

  /** 登录成功收尾（密码直登与 MFA 扫码共用）：教务会话校验 + 姓名画像 + 状态落盘 */
  private async finalizeLoginSuccess(input: CduLoginInput): Promise<void> {
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    const roleJson = await this.fetchCurrentRole(ses)
    const data = roleJson?.data
    console.log(`[cdu-mfa] 教务会话校验 ret=${roleJson?.ret ?? 'null'} role=${data?.currentRoleId ?? 'none'}`)
    if (!data || data.currentRoleId !== 'xs') {
      throw new Error('教务会话建立失败：未取得学生角色，请确认使用学生账号')
    }
    const studentName = (await this.fetchStudentName(ses)) ?? data.currentUserName ?? input.username.trim()
    this.profile = {
      studentId: input.username.trim(),
      studentName,
      role: data.currentRoleId,
      semester: data.dataXnxq,
      status: 'active',
      rememberPassword: input.rememberPassword,
      lastLoginAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    this.persistAccount(input.password, input.rememberPassword === true)
    this.emitStatus()
    this.startKeepAlive()
    this.onMfaQrCallback?.({ phase: 'completed', hint: '登录成功' })
  }

  private emitMfaQr(): void {
    if (!this.mfa) return
    this.onMfaQrCallback?.(this.getMfaQrSnapshot())
  }


  /** 校验教务会话有效性（同时取回角色与当前学年学期） */
  private async verifyJwSession(): Promise<boolean> {
    try {
      const ses = session.fromPartition(CDU_SESSION_PARTITION)
      const roleJson = await this.fetchCurrentRole(ses)
      return roleJson?.ret === 0 && roleJson?.data?.currentRoleId === 'xs'
    } catch {
      return false
    }
  }

  /**
   * 拉取教务角色接口（会话探活的标准探针）。
   * 注意：该接口为 POST（GET 会命中正方「页面正在修复中」404 页）；
   * Electron fetch 的 response.url 恒为空，会话失效一律通过非 JSON 响应识别。
   */
  private async fetchCurrentRole(ses: Electron.Session): Promise<{ ret: number; data?: { currentRoleId?: string; currentUserName?: string; dataXnxq?: string } } | null> {
    const response = await this.fetchWithTimeout(ses, `${CDU_JW_BASE}/admin/api/getCurrentRole`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }, '教务角色探针')
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      return null
    }
    return (await response.json()) as { ret: number; data?: { currentRoleId?: string; currentUserName?: string; dataXnxq?: string } }
  }

  /** 从教务主框架页抓取「姓名/学号」画像（登录落地页无姓名时的兜底） */
  private async fetchStudentName(ses: Electron.Session): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(ses, `${CDU_JW_BASE}/admin`, { redirect: 'follow' }, '教务首页')
      const html = await response.text()
      return parseStudentNameFromAdminHtml(html)
    } catch {
      return null
    }
  }

  /** 验证码预检：count > 0 或 captchaInvisible 时 CAS 强制验证码，如实报错终止；接口不可用（401 等）时静默放行 */
  private async ensureNoCaptchaRequired(ses: Electron.Session, username: string): Promise<void> {
    const response = await this.fetchWithTimeout(
      ses,
      `${CDU_CAS_BASE}/api/protected/user/findCaptchaCount/${encodeURIComponent(username)}`,
      { headers: { referer: `${CDU_CAS_BASE}/login` } },
      '验证码预检',
    )
    if (!response.ok) return
    const payload = (await response.json()) as { data?: { count?: number; captchaInvisible?: boolean; captchaUrl?: string | null } }
    const data = payload?.data
    if (data && (data.captchaInvisible === true || (data.count ?? 0) > 0 || data.captchaUrl)) {
      throw new Error('统一身份认证要求验证码（近期登录失败次数过多），请稍后重试或先在浏览器登录一次')
    }
  }

  /** 带超时的分区 Session fetch：超时必须真正 abort，否则旧请求会继续挂在同一会话上 */
  private async fetchWithTimeout(
    ses: Electron.Session,
    url: string,
    init?: RequestInit,
    label = '请求',
  ): Promise<GlobalResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await ses.fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        console.warn(`[cdu-auth] ${label}超时（${REQUEST_TIMEOUT_MS}ms）：${url.split('?')[0]}`)
        throw new Error('网络请求超时，请检查校园网/VPN 连接')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** 密码按用户选择加密落盘（仅密码字段加密，绝不存明文） */
  private persistAccount(password: string, remember: boolean): void {
    const stored: StoredCduAccount = {
      studentId: this.profile.studentId,
      studentName: this.profile.studentName,
      rememberPassword: remember,
      lastLoginAt: this.profile.lastLoginAt,
    }
    if (remember) {
      stored.passwordEncrypted = encryptToken(password)
    }
    writeJsonFileAtomic(getCduAccountPath(), stored)
  }

  /** 启动静默保活心跳 */
  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      void this.keepAliveTick()
    }, KEEP_ALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  /** 心跳探活：失效则如实标记 expired 并广播，绝不假装在线 */
  private async keepAliveTick(): Promise<void> {
    if (this.profile.status !== 'active') return
    const alive = await this.verifyJwSession()
    if (alive) {
      this.profile = { ...this.profile, lastActiveAt: Date.now() }
    } else {
      this.stopKeepAlive()
      this.profile = { ...this.profile, status: 'expired' }
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.onStatusChangeCallback?.(this.getProfile())
  }
}

export const cduAuthManager = new CduAuthManager()
