/**
 * CDU 校园网 VPN 管理器（WireGuard → 本地 SOCKS5）
 *
 * 设计取舍：
 *
 *   1. 用用户态内核 wireproxy，不装 TUN 驱动、不要管理员权限。
 *      隧道只在「本次连接」生效，系统路由表与其它分区的流量完全不受影响。
 *   2. 隧道只挂到 persist:cdu-zone 这一个分区上（CDU 专区的 CAS/教务/ISP 共用它），
 *      渲染层通过 session.setProxy 之后的 ses.fetch 自动走隧道，无需改业务代码。
 *   3. 不做「自动重连」。学校规定同一份配置同一时间只能一台设备在线，
 *      崩溃后自动重连会和用户手机上的会话互相顶掉，表现为握手永远没响应。
 *      因此连接是显式动作：启动不自动连、崩溃停在 error、退出必断开。
 *   4. 私钥只在建立隧道的瞬间解密到磁盘上的临时配置，断开即删除。
 */

import { app, dialog, session } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import type { CduNetState, CduVpnConfigSummary, CduVpnState } from '@profer/shared'
import { resolveConfigDir } from '../config-paths'
// 分区常量与 CDU 认证管理器同源，避免两处字面量漂移（cdu-detail-window 同样直接引用）
import { CDU_SESSION_PARTITION } from './cdu-auth-manager'
import {
  clearVpnConfig,
  loadVpnConfig,
  parseWireGuardConf,
  saveVpnConfig,
  type ParsedWgConfig,
} from './cdu-vpn-config'
import { probeCduNetworkState } from './cdu-net-probe'

/** 单次等待 SOCKS 端口就绪的上限 */
const READY_TIMEOUT_MS = 6_000
/** 就绪探测间隔 */
const READY_POLL_MS = 150

/**
 * 只把校园域名交给隧道，其余目标由 wireproxy 直连。
 *
 * 这是必需的：不设 TunnelDomains 时 wireproxy 会把**所有**目标都塞进隧道，
 * 而学校配置的 AllowedIPs 只覆盖校内网段，结果就是校园页面里引用的
 * CDN / 字体 / 统计脚本全部超时。
 *
 * 说明：匹配的是 SOCKS5 传来的目标主机名。Chromium 在 socks5:// 下发送的是
 * 域名而非本地解析后的 IP，所以域名规则即可覆盖正常导航；若某些页面硬编码
 * IP 访问，需要再补对应的正则。
 */
const CDU_TUNNEL_DOMAINS = ['^(.*\\.)?cdu\\.edu\\.cn$']

/** 默认 MTU：学校下发的 conf 没写 MTU，取比 1420 保守的值减少大包分片 */
const DEFAULT_MTU = 1408

let status: CduVpnState['status'] = 'not-configured'
let child: ChildProcess | null = null
let socksPort: number | undefined
let appliedToSession = false
let lastError: string | undefined
let netState: CduNetState = 'unknown'
let netCheckedAt: string | undefined
let cachedSummary: CduVpnConfigSummary | null = null
let summaryLoaded = false
let stopping = false
let stderrTail = ''
let statusCallback: ((state: CduVpnState) => void) | undefined

function getRuntimeDir(): string {
  return join(resolveConfigDir(), 'cdu-vpn')
}

function getRuntimeConfigPath(): string {
  return join(getRuntimeDir(), 'wireproxy.conf')
}

function getPidPath(): string {
  return join(getRuntimeDir(), 'wireproxy.pid')
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy'
}

/**
 * 内置内核路径。
 * dev: apps/electron/dist 同级的 resources/bin（build:resources 会拷过去）
 * prod: electron-builder extraResources 的 bin/ 目录
 */
function getBinaryPath(): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname, 'resources', 'bin')
  return join(base, getBinaryName())
}

function loadSummaryOnce(): CduVpnConfigSummary | null {
  if (!summaryLoaded) {
    const loaded = loadVpnConfig()
    cachedSummary = loaded?.summary ?? null
    summaryLoaded = true
    if (cachedSummary && status === 'not-configured') status = 'stopped'
  }
  return cachedSummary
}

export function getVpnState(): CduVpnState {
  reapOrphanedTunnel()
  const summary = loadSummaryOnce()
  return {
    status: summary ? status : 'not-configured',
    config: summary,
    socksPort: status === 'connected' ? socksPort : undefined,
    error: lastError,
    netState,
    netCheckedAt,
    appliedToSession,
  }
}

export function setVpnStatusCallback(callback: (state: CduVpnState) => void): void {
  statusCallback = callback
}

function emit(): void {
  const state = getVpnState()
  try {
    statusCallback?.(state)
  } catch (error) {
    console.warn('[cdu-vpn] 状态回调异常:', error instanceof Error ? error.message : error)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配本地端口'))))
    })
  })
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, READY_POLL_MS)
      })
    }
    attempt()
  })
}

/**
 * 生成 wireproxy 运行时配置。
 *
 * 字段名与 wg-quick 一致（wireproxy 的解析器不区分大小写）；
 * Address 必须是 CIDR，学校下发的 /32 正好合适。
 */
function buildWireproxyConfig(parsed: ParsedWgConfig, port: number): string {
  const lines: string[] = [
    '# 由 CDUT Studio 生成；断开连接时自动删除，请勿手工修改',
    '[Interface]',
    `Address = ${parsed.address}`,
    `PrivateKey = ${parsed.privateKey}`,
    `MTU = ${parsed.mtu ?? DEFAULT_MTU}`,
    '',
    '[Peer]',
    `PublicKey = ${parsed.peerPublicKey}`,
  ]

  if (parsed.presharedKey) lines.push(`PresharedKey = ${parsed.presharedKey}`)
  lines.push(`Endpoint = ${parsed.endpointHost}:${parsed.endpointPort}`)
  if (parsed.persistentKeepalive > 0) {
    lines.push(`PersistentKeepalive = ${parsed.persistentKeepalive}`)
  }
  lines.push(`AllowedIPs = ${parsed.allowedIps.join(', ')}`)
  lines.push('', '[Socks5]', `BindAddress = 127.0.0.1:${port}`)
  for (const pattern of CDU_TUNNEL_DOMAINS) lines.push(`TunnelDomains = ${pattern}`)

  return `${lines.join('\n')}\n`
}

/** 读取并校验导入的文件：支持 .conf 与含 .conf 的 .zip */
async function readImportedConfig(filePath: string): Promise<ParsedWgConfig> {
  const buffer = readFileSync(filePath)

  if (filePath.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(buffer)
    const entry = Object.values(zip.files).find(
      (file) => !file.dir && file.name.toLowerCase().endsWith('.conf'),
    )
    if (!entry) throw new Error('压缩包里没有找到 .conf 配置文件')
    return parseWireGuardConf(await entry.async('string'))
  }

  return parseWireGuardConf(buffer.toString('utf8'))
}

function killChild(): void {
  if (!child) {
    rmSync(getPidPath(), { force: true })
    return
  }
  const current = child
  child = null
  current.removeAllListeners()
  try {
    current.kill()
  } catch {
    // 进程可能已经退出
  }
  rmSync(getPidPath(), { force: true })
}

/**
 * 清理上次异常退出遗留的隧道进程。
 *
 * 为什么要做：学校规定同一份配置同一时间只能一台设备在线。若应用崩溃而
 * 内核没被回收，遗留进程会继续占着服务端会话——新一次连接握手永远没有响应，
 * 用户只会看到「隧道已建立但校园网不可达」，很难自查。
 *
 * 安全性：只按 PID 文件定位，并二次确认该 PID 的映像名确实是 wireproxy，
 * 避免 PID 复用误杀其它进程。
 */
let orphanChecked = false
function reapOrphanedTunnel(): void {
  if (orphanChecked) return
  orphanChecked = true

  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return

  let pid = 0
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  } catch {
    // 读不到就当作没有
  }
  rmSync(pidPath, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return

  try {
    process.kill(pid, 0) // 仅探测存活；进程不存在会抛错
  } catch {
    return
  }

  try {
    if (process.platform === 'win32') {
      const list = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (!list.toLowerCase().includes('wireproxy')) return
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    console.warn('[cdu-vpn] 已清理上次异常退出遗留的隧道进程 pid=%d', pid)
  } catch {
    // 清理失败不阻断主流程
  }
}

async function clearSessionProxy(): Promise<void> {
  try {
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    await ses.setProxy({ mode: 'direct' })
    await ses.closeAllConnections()
  } catch (error) {
    console.warn('[cdu-vpn] 清除分区代理失败:', error instanceof Error ? error.message : error)
  }
  appliedToSession = false
}

/** 打开文件选择器导入配置；解析、校验、加密落盘全部在主进程完成 */
export async function importVpnConfig(): Promise<{ success: boolean; error?: string; state: CduVpnState }> {
  const picked = await dialog.showOpenDialog({
    title: '导入校园网 WireGuard 配置',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [{ name: 'WireGuard 配置 (*.conf, *.zip)', extensions: ['conf', 'zip'] }],
  })

  if (picked.canceled || picked.filePaths.length === 0) {
    return { success: false, state: getVpnState() }
  }

  try {
    const parsed = await readImportedConfig(picked.filePaths[0]!)
    // 换配置必须先断开旧隧道，否则旧会话仍占着服务端 peer 槽位
    if (status === 'connected' || child) await disconnectVpn()
    cachedSummary = saveVpnConfig(parsed)
    summaryLoaded = true
    status = 'stopped'
    lastError = undefined
    netState = 'unknown'
    netCheckedAt = undefined
    emit()
    return { success: true, state: getVpnState() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lastError = message
    emit()
    return { success: false, error: message, state: getVpnState() }
  }
}

/** 建立隧道并把 persist:cdu-zone 分区指向本地 SOCKS5 */
export async function connectVpn(): Promise<CduVpnState> {
  const loaded = loadVpnConfig()
  if (!loaded) {
    cachedSummary = null
    summaryLoaded = true
    status = 'not-configured'
    emit()
    return getVpnState()
  }

  if (status === 'connected' && child) return getVpnState()

  const binaryPath = getBinaryPath()
  if (!existsSync(binaryPath)) {
    status = 'error'
    lastError = `内置 wireproxy 内核缺失：${binaryPath}。开发环境请先执行 scripts/fetch-wireproxy.mjs`
    emit()
    return getVpnState()
  }

  status = 'starting'
  lastError = undefined
  stopping = false
  emit()

  try {
    const port = await findFreePort()
    mkdirSync(getRuntimeDir(), { recursive: true })
    const configPath = getRuntimeConfigPath()
    // 明文配置只在这一刻存在，断开时删除
    writeFileSync(configPath, buildWireproxyConfig(loaded.parsed, port), { mode: 0o600 })

    stderrTail = ''
    const proc = spawn(binaryPath, ['-c', configPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child = proc
    // 记录 PID：应用异常退出后，下次启动据此回收遗留进程（否则会占着服务端会话）
    try {
      if (proc.pid) writeFileSync(getPidPath(), String(proc.pid), { mode: 0o600 })
    } catch {
      // PID 文件写失败不影响隧道建立
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      // 只保留尾部，避免无限增长；内容不含密钥
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
    })

    const ready = await waitForPort(port, READY_TIMEOUT_MS)
    if (!ready) {
      killChild()
      rmSync(configPath, { force: true })
      status = 'error'
      lastError = stderrTail.trim()
        ? `本地 SOCKS5 未能启动：${stderrTail.trim().slice(-200)}`
        : '本地 SOCKS5 未能启动，请检查内核是否被杀软拦截'
      emit()
      return getVpnState()
    }

    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    // Chromium 在 socks5:// 下会把域名交给代理解析（远程 DNS），
    // 因此校园内网域名不会先被本地 DNS 污染/解析失败。
    await ses.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` })
    await ses.closeAllConnections()

    socksPort = port
    appliedToSession = true
    status = 'connected'
    lastError = undefined
    emit()

    // 异常退出不做自动重连：单设备限制下重连会与用户其它设备互顶
    proc.once('exit', (code) => {
      if (stopping || child !== proc) return
      child = null
      socksPort = undefined
      status = 'error'
      lastError = `隧道进程意外退出（code=${code ?? 'null'}）${stderrTail ? `：${stderrTail.trim().slice(-200)}` : ''}`
      void clearSessionProxy().then(() => emit())
    })

    return getVpnState()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    killChild()
    rmSync(getRuntimeConfigPath(), { force: true })
    await clearSessionProxy()
    status = 'error'
    lastError = message
    emit()
    return getVpnState()
  }
}

/** 断开隧道、清除分区代理并删除运行时明文配置 */
export async function disconnectVpn(): Promise<CduVpnState> {
  stopping = true
  killChild()
  await clearSessionProxy()
  rmSync(getRuntimeConfigPath(), { force: true })
  socksPort = undefined
  status = loadSummaryOnce() ? 'stopped' : 'not-configured'
  emit()
  return getVpnState()
}

/** 删除本地配置（同时断开隧道） */
export async function removeVpnConfig(): Promise<CduVpnState> {
  await disconnectVpn()
  clearVpnConfig()
  rmSync(getRuntimeDir(), { recursive: true, force: true })
  cachedSummary = null
  summaryLoaded = true
  status = 'not-configured'
  lastError = undefined
  netState = 'unknown'
  netCheckedAt = undefined
  emit()
  return getVpnState()
}

/**
 * 登录后探测当前是否具备校园网访问权限。
 *
 * 探测走 persist:cdu-zone 分区，因此「直连可达」和「经隧道可达」都会判为 ok；
 * 只有被网关换成拦截页才判 blocked —— 这正是用户需要看到的结论。
 */
export async function probeVpnNetwork(): Promise<CduVpnState> {
  try {
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    const result = await probeCduNetworkState(ses)
    netState = result.state
    netCheckedAt = new Date().toISOString()

    if (result.state === 'unreachable' && status === 'connected') {
      // 隧道起来了却完全不可达：最常见原因是同一份配置已在别的设备在线
      lastError = '隧道已建立但校园网不可达：该配置可能已在其它设备在线，请先在那边断开'
    } else if (result.state === 'ok' && status === 'connected') {
      lastError = undefined
    }
  } catch (error) {
    netState = 'unreachable'
    netCheckedAt = new Date().toISOString()
    console.warn('[cdu-vpn] 网络探测失败:', error instanceof Error ? error.message : error)
  }

  emit()
  return getVpnState()
}

/**
 * 进程退出兜底：同步杀掉子进程并清掉明文配置。
 * before-quit 阶段无法等待 Promise，所以这里是同步实现。
 */
export function shutdownVpnSync(): void {
  stopping = true
  killChild()
  rmSync(getRuntimeConfigPath(), { force: true })
  socksPort = undefined
  appliedToSession = false
}

// 应用退出时确保子进程被回收，避免残留进程继续占用服务端会话
app.on('will-quit', () => {
  shutdownVpnSync()
})
