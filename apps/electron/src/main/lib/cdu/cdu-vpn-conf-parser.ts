/**
 * WireGuard 配置解析（纯函数，不依赖 Electron）
 *
 * 从 cdu-vpn-config 中拆出来，让解析逻辑可以被单元测试直接覆盖：
 * 真实 .conf 的字段顺序、大小写、逗号分隔、IPv6 混排等差异都靠这里兜住。
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'

/** X25519 私钥的 PKCS#8 DER 前缀（后接 32 字节裸私钥） */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** 解析后的 WireGuard 配置（含密钥，禁止下发展示层） */
export interface ParsedWgConfig {
  /** 隧道内本地 IPv4，含前缀，如 10.0.0.2/32 */
  address: string
  /** 隧道内本地 IPv6（可选） */
  addressV6?: string
  privateKey: string
  peerPublicKey: string
  presharedKey?: string
  endpointHost: string
  endpointPort: number
  /** 允许进入隧道的目标网段；这是「哪些目标可走隧道」，不是分流规则 */
  allowedIps: string[]
  persistentKeepalive: number
  mtu?: number
}

export function isBase64Key(value: string): boolean {
  try {
    return Buffer.from(value, 'base64').length === 32
  } catch {
    return false
  }
}

/**
 * 由私钥派生公钥（X25519）。
 *
 * WireGuard 私钥是 clamp 过的 32 字节，Node 的 X25519 实现同样做 clamp，
 * 因此派生结果与 `wg pubkey` 一致。用于在设置页展示「这台设备的公钥」，
 * 便于用户与学校门户里的设备记录核对。
 */
export function deriveWireGuardPublicKey(privateKeyBase64: string): string {
  const raw = Buffer.from(privateKeyBase64, 'base64')
  if (raw.length !== 32) throw new Error('WireGuard 私钥长度不正确')
  const key = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' })
  return spki.subarray(spki.length - 32).toString('base64')
}

/**
 * 解析 wg-quick 格式配置。
 *
 * 只接受 [Interface] 与 [Peer] 两段；任何必需字段缺失都直接抛错，
 * 错误文案面向用户，说明「哪里不对、该怎么拿正确的文件」。
 */
export function parseWireGuardConf(text: string): ParsedWgConfig {
  const cleaned = text.replace(/^\uFEFF/, '')
  const lines = cleaned.split(/\r?\n/)

  let section: 'interface' | 'peer' | '' = ''
  const iface = new Map<string, string>()
  const peer = new Map<string, string>()

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = /^\[(.+)]$/.exec(line)
    if (sectionMatch) {
      const name = sectionMatch[1]!.trim().toLowerCase()
      section = name === 'interface' ? 'interface' : name === 'peer' ? 'peer' : ''
      continue
    }

    if (!section) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue

    const key = line
      .slice(0, eq)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
    const value = line.slice(eq + 1).trim()
    const target = section === 'interface' ? iface : peer
    // 多 Peer 配置只取第一个：学校下发的都是单 Peer，多 Peer 属于未支持场景
    if (!target.has(key)) target.set(key, value)
  }

  const interfaceAddress = iface.get('address') ?? ''
  if (!interfaceAddress) {
    throw new Error('缺少 [Interface] Address：这不是学校下发的 WireGuard 配置')
  }

  const addressParts = interfaceAddress
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const address = addressParts.find((part) => !part.includes(':'))
  const addressV6 = addressParts.find((part) => part.includes(':'))

  if (!address || !address.includes('/')) {
    throw new Error('Interface Address 缺少 IPv4 前缀（应形如 10.0.0.2/32）')
  }

  const privateKey = iface.get('privatekey') ?? ''
  if (!isBase64Key(privateKey)) {
    throw new Error('Interface PrivateKey 缺失或不是合法的 32 字节 Base64')
  }

  const peerPublicKey = peer.get('publickey') ?? ''
  if (!isBase64Key(peerPublicKey)) {
    throw new Error('Peer PublicKey 缺失或不是合法的 32 字节 Base64')
  }

  const endpointRaw = peer.get('endpoint') ?? ''
  const endpointSplit = endpointRaw.lastIndexOf(':')
  if (endpointSplit <= 0) {
    throw new Error('Peer Endpoint 缺失或格式不对（应形如 192.0.2.10:51820）')
  }

  const endpointHost = endpointRaw.slice(0, endpointSplit).replace(/^\[|\]$/g, '')
  const endpointPort = Number.parseInt(endpointRaw.slice(endpointSplit + 1), 10)
  if (!endpointHost || !Number.isInteger(endpointPort) || endpointPort <= 0 || endpointPort > 65535) {
    throw new Error('Peer Endpoint 端口不合法')
  }

  const allowedIps = (peer.get('allowedips') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (allowedIps.length === 0) {
    throw new Error('Peer AllowedIPs 缺失：无法确定哪些校园网段应走隧道')
  }

  const presharedKey = peer.get('presharedkey')

  const keepaliveRaw = peer.get('persistentkeepalive')
  const parsedKeepalive = keepaliveRaw ? Number.parseInt(keepaliveRaw, 10) : 25

  const mtuRaw = iface.get('mtu')
  const parsedMtu = mtuRaw ? Number.parseInt(mtuRaw, 10) : undefined

  return {
    address,
    addressV6,
    privateKey,
    peerPublicKey,
    presharedKey: presharedKey && isBase64Key(presharedKey) ? presharedKey : undefined,
    endpointHost,
    endpointPort,
    allowedIps,
    persistentKeepalive:
      Number.isInteger(parsedKeepalive) && parsedKeepalive > 0 ? parsedKeepalive : 25,
    mtu: parsedMtu && Number.isInteger(parsedMtu) ? parsedMtu : undefined,
  }
}
