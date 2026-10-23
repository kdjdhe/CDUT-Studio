import { describe, expect, test } from 'bun:test'
import { deriveWireGuardPublicKey, parseWireGuardConf } from './cdu-vpn-conf-parser'

// 测试一律使用合成密钥，绝不写入真实配置
const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const KEY_C = Buffer.alloc(32, 3).toString('base64')

/** 学校下发格式的标准样例（全部使用文档保留网段与合成密钥） */
const SAMPLE = `[Interface]
PrivateKey = ${KEY_A}
Address = 10.0.0.2/32, fd00::2/128

[Peer]
PublicKey = ${KEY_B}
PresharedKey = ${KEY_C}
AllowedIPs = 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
Endpoint = 192.0.2.10:51820
PersistentKeepalive = 25
`

describe('parseWireGuardConf', () => {
  test('解析学校格式：分离 IPv4/IPv6，保留网段与保活', () => {
    const parsed = parseWireGuardConf(SAMPLE)

    expect(parsed.address).toBe('10.0.0.2/32')
    expect(parsed.addressV6).toBe('fd00::2/128')
    expect(parsed.endpointHost).toBe('192.0.2.10')
    expect(parsed.endpointPort).toBe(51820)
    expect(parsed.allowedIps).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
    expect(parsed.persistentKeepalive).toBe(25)
    expect(parsed.presharedKey).toBe(KEY_C)
    expect(parsed.mtu).toBeUndefined()
  })

  test('键名大小写与多余空格不敏感', () => {
    const parsed = parseWireGuardConf(`
[INTERFACE]
  privatekey   =   ${KEY_A}
  ADDRESS = 10.0.0.5/32
[Peer]
  PUBLICKEY = ${KEY_B}
  endpoint = 1.2.3.4:51820
  allowedips = 10.0.0.0/8
`)
    expect(parsed.address).toBe('10.0.0.5/32')
    expect(parsed.endpointPort).toBe(51820)
  })

  test('缺少 Address 时给出面向用户的错误', () => {
    expect(() => parseWireGuardConf('[Interface]\nPrivateKey = ' + KEY_A)).toThrow(/Address/)
  })

  test('私钥不是 32 字节 Base64 时拒绝导入', () => {
    expect(() =>
      parseWireGuardConf(`[Interface]\nAddress = 10.0.0.2/32\nPrivateKey = not-a-key`),
    ).toThrow(/PrivateKey/)
  })

  test('Endpoint 端口越界时拒绝导入', () => {
    const broken = SAMPLE.replace('192.0.2.10:51820', '192.0.2.10:99999')
    expect(() => parseWireGuardConf(broken)).toThrow(/端口/)
  })

  test('缺少 AllowedIPs 时拒绝导入', () => {
    const broken = SAMPLE.replace(/AllowedIPs = .+\n/, '')
    expect(() => parseWireGuardConf(broken)).toThrow(/AllowedIPs/)
  })

  test('多 Peer 只取第一个（未支持场景下的确定行为）', () => {
    const parsed = parseWireGuardConf(`${SAMPLE}
[Peer]
PublicKey = ${KEY_C}
AllowedIPs = 10.9.0.0/16
Endpoint = 198.51.100.20:1111
`)
    expect(parsed.peerPublicKey).toBe(KEY_B)
    expect(parsed.endpointHost).toBe('192.0.2.10')
  })

  test('MTU 缺省为 undefined，给出时按数值解析', () => {
    const withMtu = SAMPLE.replace('[Peer]', 'MTU = 1280\n\n[Peer]')
    expect(parseWireGuardConf(withMtu).mtu).toBe(1280)
  })
})

describe('deriveWireGuardPublicKey', () => {
  test('由私钥派生出的公钥是 32 字节 Base64，且与私钥不同', () => {
    const publicKey = deriveWireGuardPublicKey(KEY_A)
    expect(Buffer.from(publicKey, 'base64')).toHaveLength(32)
    expect(publicKey).not.toBe(KEY_A)
  })

  test('派生结果稳定（同一私钥多次调用一致）', () => {
    expect(deriveWireGuardPublicKey(KEY_A)).toBe(deriveWireGuardPublicKey(KEY_A))
  })

  test('长度非法时抛错', () => {
    expect(() => deriveWireGuardPublicKey('short')).toThrow()
  })
})
