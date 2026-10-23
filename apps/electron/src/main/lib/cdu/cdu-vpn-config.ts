/**
 * WireGuard 配置的本地加密存储
 *
 * 解析与校验在 cdu-vpn-conf-parser.ts（纯函数，可单测）；本模块只负责：
 *   - 生成可展示摘要（不含任何密钥）；
 *   - 用 token-crypto 加密私钥/预共享密钥后落盘到 ~/.cdutai/cdu-vpn.json。
 *
 * 为什么不用 wireproxy 的 `WGConfig = <path>` 直接引用原始文件：
 *   - 原始文件同样必须解密落到磁盘，安全性并不会更好；
 *   - 自建配置可以强制 MTU、并注入 TunnelDomains 分流段，避免用户改坏；
 *   - 解析后才能在不下发密钥的前提下给渲染层展示摘要。
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CduVpnConfigSummary } from '@profer/shared'
import { resolveConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { decryptToken, encryptToken } from '../token-crypto'
import {
  deriveWireGuardPublicKey,
  parseWireGuardConf,
  type ParsedWgConfig,
} from './cdu-vpn-conf-parser'

// 解析能力从本模块统一再导出，调用方无需关心文件拆分
export { deriveWireGuardPublicKey, parseWireGuardConf, type ParsedWgConfig }

interface StoredVpnConfig {
  version: 1
  importedAt: string
  summary: CduVpnConfigSummary
  /** encryptToken(JSON.stringify(ParsedWgConfig)) */
  secret: string
}

/** 生成可安全展示的摘要（不含任何密钥） */
export function toConfigSummary(parsed: ParsedWgConfig, importedAt: string): CduVpnConfigSummary {
  return {
    endpoint: `${parsed.endpointHost}:${parsed.endpointPort}`,
    address: parsed.address,
    publicKey: deriveWireGuardPublicKey(parsed.privateKey),
    allowedIpCount: parsed.allowedIps.length,
    importedAt,
  }
}

function getVpnStorePath(): string {
  return join(resolveConfigDir(), 'cdu-vpn.json')
}

export interface LoadedVpnConfig {
  summary: CduVpnConfigSummary
  parsed: ParsedWgConfig
}

/**
 * 读取本地配置。
 *
 * 解密失败（换机 / 重装导致 deviceId 变化）时不抛错，返回 null，
 * 由上层提示用户重新导入——这比让设置页处理异常更符合语义。
 */
export function loadVpnConfig(): LoadedVpnConfig | null {
  const stored = readJsonFileSafe<StoredVpnConfig>(getVpnStorePath())
  if (!stored || stored.version !== 1 || !stored.secret || !stored.summary) return null

  try {
    const plaintext = decryptToken(stored.secret)
    const parsed = JSON.parse(plaintext) as ParsedWgConfig
    if (!parsed.privateKey || !parsed.peerPublicKey || !parsed.endpointHost) return null
    return { summary: stored.summary, parsed }
  } catch (error) {
    console.warn('[cdu-vpn] 配置解密失败，需要重新导入:', error instanceof Error ? error.message : error)
    return null
  }
}

export function saveVpnConfig(parsed: ParsedWgConfig): CduVpnConfigSummary {
  const importedAt = new Date().toISOString()
  const summary = toConfigSummary(parsed, importedAt)
  const stored: StoredVpnConfig = {
    version: 1,
    importedAt,
    summary,
    secret: encryptToken(JSON.stringify(parsed)),
  }
  writeJsonFileAtomic(getVpnStorePath(), stored)
  return summary
}

export function clearVpnConfig(): void {
  rmSync(getVpnStorePath(), { force: true })
}
