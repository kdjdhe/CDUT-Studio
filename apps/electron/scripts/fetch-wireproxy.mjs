#!/usr/bin/env node
/**
 * 拉取并校验内置的 wireproxy 内核（CDU 校园网 VPN 使用）。
 *
 * 为什么需要脚本而不是直接提交二进制：
 *   resources/bin/ 在 .gitignore 内（与 profer 同策略），仓库不带二进制；
 *   构建机需要可复现地拿到固定版本，并且必须校验官方 checksums。
 *
 * 用法：
 *   node scripts/fetch-wireproxy.mjs            # 已存在则跳过
 *   node scripts/fetch-wireproxy.mjs --force    # 强制重新下载
 *
 * 网络受限时设置 HTTPS_PROXY 走代理（脚本会退回 curl 执行下载）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 固定版本，升级时同步更新 README 的鸣谢段落 */
const VERSION = '1.1.3'
const REPO = 'pufferffish/wireproxy'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'resources', 'bin')
const LICENSE_DIR = join(ROOT, 'resources', 'licenses')

function resolveAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch]
  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
  if (!arch || !platform) {
    throw new Error(`不支持的平台：${process.platform}/${process.arch}`)
  }
  return `wireproxy_${platform}_${arch}.tar.gz`
}

function binaryName() {
  return process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy'
}

async function download(url, dest) {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
    return
  } catch (directError) {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
    if (!proxy) throw directError
    console.log(`  直连失败（${directError.message}），改走代理 ${proxy}`)
    execFileSync('curl', ['-sL', '--max-time', '300', '-x', proxy, '-o', dest, url], { stdio: 'inherit' })
  }
}

async function main() {
  const force = process.argv.includes('--force')
  const target = join(BIN_DIR, binaryName())

  if (existsSync(target) && !force) {
    console.log(`[wireproxy] 已存在，跳过：${target}`)
    return
  }

  const asset = resolveAsset()
  const base = `https://github.com/${REPO}/releases/download/v${VERSION}`
  const workDir = mkdtempSync(join(tmpdir(), 'wireproxy-'))

  try {
    console.log(`[wireproxy] 下载 v${VERSION} ${asset}`)
    const archive = join(workDir, asset)
    const checksums = join(workDir, 'checksums.txt')
    await download(`${base}/${asset}`, archive)
    await download(`${base}/checksums.txt`, checksums)

    const expected = readFileSync(checksums, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+\*?/))
      .find((parts) => parts[1] === asset)?.[0]
    if (!expected) throw new Error(`checksums.txt 中没有 ${asset} 的记录`)

    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (actual !== expected) {
      throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`)
    }
    console.log(`[wireproxy] 校验通过 ${actual.slice(0, 16)}…`)

    execFileSync('tar', ['-xzf', archive, '-C', workDir], { stdio: 'inherit' })

    mkdirSync(BIN_DIR, { recursive: true })
    const extracted = join(workDir, binaryName())
    if (!existsSync(extracted)) throw new Error('压缩包内没有找到 wireproxy 可执行文件')
    writeFileSync(target, readFileSync(extracted))
    if (process.platform !== 'win32') chmodSync(target, 0o755)
    console.log(`[wireproxy] 已写入 ${target}`)

    // ISC 许可要求随分发保留版权与许可原文，这里一并落盘供打包引用
    mkdirSync(LICENSE_DIR, { recursive: true })
    const license = await fetch(`https://raw.githubusercontent.com/${REPO}/master/LICENSE`).then((res) => res.text())
    writeFileSync(join(LICENSE_DIR, 'wireproxy-LICENSE'), license, 'utf8')
    console.log(`[wireproxy] 许可原文已保存`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[wireproxy] 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
