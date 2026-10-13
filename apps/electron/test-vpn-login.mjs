/**
 * CDU VPN（深信服 EasyConnect）WebVPN 接口诊断脚本
 * 用法：
 *   electron.exe test-vpn-login.mjs captcha   → 建立 TWFID 会话并保存验证码图片
 *   electron.exe test-vpn-login.mjs <识别码>  → 带验证码登录并枚举资源
 * 说明：验证码由人工查看图片后输入（脚本不做任何验证码绕过），会话持久化于 persist:cdu-vpn-test 分区。
 */
import { app, session } from 'electron'
import { createPublicKey, publicEncrypt, constants as cryptoConstants, createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VPN_BASE = 'https://vpn.cdu.edu.cn'
const CAPTCHA_FILE = join(dirname(fileURLToPath(import.meta.url)), 'test-vpn-captcha.gif')

const mode = process.argv[2] ?? ''

function loadCredentials() {
  if (process.env.CDU_TEST_USER && process.env.CDU_TEST_PASS) {
    return [process.env.CDU_TEST_USER, process.env.CDU_TEST_PASS]
  }
  const credPath = process.env.CDU_TEST_CRED
  if (!credPath) {
    console.error('缺少凭据：请设置 CDU_TEST_USER/CDU_TEST_PASS 环境变量，或用 CDU_TEST_CRED 指定凭据文件路径')
    process.exit(1)
  }
  return readFileSync(credPath, 'utf8').trim().split(/\r?\n/).map((s) => s.trim())
}
const [username, password] = loadCredentials()

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1].trim() : null
}

/** Sangfor encryptID 复现：RSA-PKCS1v1.5(密码 + "_" + csrfRandCode)，十六进制输出 */
function encryptPassword(password, csrfRandCode, rsaKeyHex) {
  const n = Buffer.from(rsaKeyHex, 'hex')
  const jwk = { kty: 'RSA', n: n.toString('base64url'), e: Buffer.from([1, 0, 1]).toString('base64url') }
  const keyObj = createPublicKey({ key: jwk, format: 'jwk' })
  return publicEncrypt(
    { key: keyObj, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(`${password}_${csrfRandCode}`, 'utf8'),
  ).toString('hex')
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:cdu-vpn-test')
  const jw = { headers: { 'X-Requested-With': 'XMLHttpRequest', referer: `${VPN_BASE}/portal/` } }
  try {
    // 步骤1: TWFID 会话 + 登录配置
    await ses.fetch(`${VPN_BASE}/por/login_psw.csp`, { redirect: 'follow' })
    const cfgRes = await ses.fetch(`${VPN_BASE}/public/psw_config`, jw)
    const cfgXml = await cfgRes.text()
    const rsaKey = xmlTag(cfgXml, 'RSA_ENCRYPT_KEY')
    const csrfRandCode = xmlTag(cfgXml, 'CSRF_RAND_CODE')
    if (!rsaKey || !csrfRandCode) {
      console.log('[失败] 未取得加密参数:', cfgXml.slice(0, 200))
      app.quit()
      return
    }
    console.log('CSRF_RAND_CODE:', csrfRandCode)

    if (mode === 'captcha') {
      // 阶段A：保存验证码图片
      const img = await ses.fetch(`${VPN_BASE}/por/rand_code.csp`, jw)
      const buf = Buffer.from(await img.arrayBuffer())
      writeFileSync(CAPTCHA_FILE, buf)
      console.log('验证码已保存:', CAPTCHA_FILE, `(${buf.length} bytes)`)
      app.quit()
      return
    }

    // 阶段B：带验证码登录
    const captcha = (mode || '').trim()
    console.log('验证码:', captcha, 'md5:', createHash('md5').update(captcha).digest('hex'))
    const encPwd = encryptPassword(password, csrfRandCode, rsaKey)
    const form = new URLSearchParams({
      mitm_result: '',
      svpn_req_randcode: csrfRandCode,
      svpn_name: username,
      svpn_password: encPwd,
      svpn_rand_code: createHash('md5').update(captcha).digest('hex'),
    })
    const loginRes = await ses.fetch(`${VPN_BASE}/por/login_psw.csp?anti_replay=1&encrypt=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${VPN_BASE}/portal/` },
      body: form.toString(),
    })
    const loginXml = await loginRes.text()
    const errCode = xmlTag(loginXml, 'ErrorCode')
    console.log('登录 ErrorCode:', errCode, 'Message:', xmlTag(loginXml, 'Message'))
    if (errCode !== '1' && errCode !== '0') {
      console.log('响应:', loginXml.slice(0, 500))
      app.quit()
      return
    }
    console.log('✅ VPN 登录成功')

    // 步骤2: 门户配置
    console.log('\n===== /por/conf.csp =====')
    const conf = await ses.fetch(`${VPN_BASE}/por/conf.csp`, jw)
    console.log((await conf.text()).slice(0, 700))

    // 步骤3: 资源列表
    console.log('\n===== /por/rclist.csp 资源列表 =====')
    const rc = await ses.fetch(`${VPN_BASE}/por/rclist.csp`, jw)
    const rcText = await rc.text()
    console.log('长度:', rcText.length)
    const tags = [...rcText.matchAll(/<([A-Z_0-9]+)>([^<]{1,200})</g)]
    const interesting = ['NAME', 'RCINFO', 'URL', 'ADDRESS', 'RCHOST', 'SHOWNAME', 'IP', 'PORT', 'TYPE']
    for (const [, tag, val] of tags) {
      if (interesting.includes(tag)) console.log(` ${tag}: ${val}`)
    }
    if (!tags.length) console.log('原始片段:', rcText.slice(0, 800))

    // 步骤4: 保活/在线时长
    console.log('\n===== /por/timequery.csp =====')
    const tq = await ses.fetch(`${VPN_BASE}/por/timequery.csp`, jw)
    console.log((await tq.text()).slice(0, 300))

    console.log('\n===== 完成 ✅ =====')
  } catch (err) {
    console.log('[异常]', err?.message ?? String(err))
  }
  app.quit()
})
