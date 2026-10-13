/**
 * CDU 登录链路独立诊断脚本（在 Electron 主进程内运行，与应用同构）
 * 用法：electron.exe test-cdu-login.mjs
 * 逐步骤打印最终 URL / 状态码，定位 ses.fetch 重定向行为差异。
 *
 * 凭据从环境变量读取（两行：用户名\n密码），或通过 CDU_TEST_CRED 指定凭据文件路径。
 * 凭据文件不入库，严禁提交到仓库。
 */
import { app, session } from 'electron'
import { createCipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

const CAS_BASE = 'https://id.cdu.edu.cn'
const JW_BASE = 'https://szjw.cdu.edu.cn'
const ENTRY = `${JW_BASE}/admin/caslogin`

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
console.log('[账号]', username, '密码长度', password?.length)

function encryptPwd(pwd, croyptoB64) {
  const key = Buffer.from(croyptoB64, 'base64')
  console.log('[密钥] 长度', key.length, '字节')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(pwd, 'utf8'), cipher.final()]).toString('base64')
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:cdu-test')
  try {
    // 步骤1: 打开 CAS 登录页
    console.log('\n===== 步骤1: GET 入口 =====')
    const page = await ses.fetch(ENTRY, { redirect: 'follow' })
    console.log('最终URL:', page.url)
    console.log('状态:', page.status, page.headers.get('content-type'))
    const html = await page.text()
    console.log('HTML 长度:', html.length)

    const execution = html.match(/id="login-page-flowkey"[^>]*>([^<]+)</)?.[1]?.trim()
    const croypto = html.match(/id="login-croypto"[^>]*>([^<]+)</)?.[1]?.trim()
    console.log('execution:', execution ? execution.slice(0, 50) + '...' : '未找到!')
    console.log('croypto:', croypto ?? '未找到!')
    if (!execution || !croypto) {
      console.log('[诊断] 未解析到流程凭据，页面片段:')
      console.log(html.slice(0, 600))
      app.quit()
      return
    }

    // 步骤2: 验证码预检（带 Referer，否则 401）
    console.log('\n===== 步骤2: findCaptchaCount =====')
    const cap = await ses.fetch(`${CAS_BASE}/api/protected/user/findCaptchaCount/${username}`, {
      headers: { referer: `${CAS_BASE}/login` },
    })
    console.log('状态:', cap.status)
    console.log('响应:', (await cap.text()).slice(0, 200))

    // 步骤3: POST 登录（Electron fetch 的 response.url 为空，POST 到 CAS 固定路径 /login，与抓包一致）
    console.log('\n===== 步骤3: POST /login =====')
    const form = new URLSearchParams({
      username,
      type: 'UsernamePassword',
      _eventId: 'submit',
      geolocation: '',
      execution,
      captcha_code: '',
      croypto,
      password: encryptPwd(password, croypto),
      captcha_payload: '',
    })
    console.log('POST 目标:', `${CAS_BASE}/login`)
    const post = await ses.fetch(`${CAS_BASE}/login`, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    console.log('状态:', post.status, 'content-type:', post.headers.get('content-type'))
    const postHtml = await post.text()
    console.log('响应HTML长度:', postHtml.length)
    console.log('页面标记探测:')
    console.log('  <title>:', postHtml.match(/<title>([^<]*)<\/title>/)?.[1] ?? '(无)')
    console.log('  含CAS登录页标记(login-page-flowkey):', postHtml.includes('login-page-flowkey'))
    console.log('  含教务系统标记(综合教务管理系统):', postHtml.includes('综合教务管理系统'))
    console.log('  含姓名:', /class="block">\s*([^<]+?)\s*<em/.test(postHtml) ? postHtml.match(/class="block">\s*([^<]+?)\s*<em/)?.[1] : '否')
    console.log('  含结果页(结果):', postHtml.includes('>结果<') || postHtml.includes('zh-CN">结果'))
    if (postHtml.includes('login-page-flowkey')) {
      const errCode = postHtml.match(/id="login-error-code"[^>]*>([^<]*)</)?.[1]
      console.log('[失败] 仍停留在 CAS 登录页，error-code:', errCode ?? '(无)')
      console.log('错误信息片段:', postHtml.match(/(用户名|密码|错误|失败|验证码)[^<]{0,80}/g)?.slice(0, 5))
      app.quit()
      return
    }
    console.log('响应开头片段:', postHtml.slice(0, 300).replace(/\s+/g, ' '))

    // 步骤4: 会话校验（权威判定，不依赖 URL；注意此接口是 POST）
    console.log('\n===== 步骤4: POST getCurrentRole =====')
    const role = await ses.fetch(`${JW_BASE}/admin/api/getCurrentRole`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    console.log('状态:', role.status, 'content-type:', role.headers.get('content-type'))
    const roleText = await role.text()
    console.log('响应长度:', roleText.length)
    // 若返回的是正方"结果"错误页，打印其中的提示文本
    if (roleText.includes('结果') && !roleText.trimStart().startsWith('{')) {
      console.log('结果页提示文本:', roleText.match(/<p[^>]*>([^<]+)<\/p>|<h\d[^>]*>([^<]+)<\/h\d>|class="result[^"]*"[^>]*>([^<]+)/g)?.slice(0, 6))
      console.log('正文片段:', roleText.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400))
    } else {
      console.log('响应:', roleText.slice(0, 300))
    }
    const roleJson = JSON.parse(roleText)
    if (roleJson?.ret !== 0 || roleJson?.data?.currentRoleId !== 'xs') {
      console.log('[失败] 教务会话未建立')
      app.quit()
      return
    }

    // 步骤5: 姓名抓取
    console.log('\n===== 步骤5: /admin 主页 =====')
    const adm = await ses.fetch(`${JW_BASE}/admin`, { redirect: 'follow' })
    const admHtml = await adm.text()
    const name = admHtml.match(/class="block">\s*([^<]+?)\s*<em[^>]*>[^<]*<\/em>\s*(\d{4,})\s*<\/span>/)
    console.log('状态:', adm.status, '姓名解析:', name?.[1] ?? '未匹配')

    // 步骤6: 四大业务域验证（与 cdu-jw-client 相同的请求构造）
    console.log('\n===== 步骤6: 业务域验证 =====')
    const semester = roleJson.data.dataXnxq
    const kb = await ses.fetch(`${JW_BASE}/admin/pkgl/xskb/queryKbForGrdb`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    const kbJson = JSON.parse(await kb.text())
    console.log('课表:', kbJson.ret === 0 ? `${kbJson.data?.length} 门课程，首门 ${kbJson.data?.[0]?.kcmc}` : `ret=${kbJson.ret}`)

    const gradeBody = new URLSearchParams({
      queryFields: 'id,xnxq,kcmc,xf,kcxz,kclx,ksxs,kcgs,xdxz,kclb,cjfxms,zhcj,jd,hdxf,tscjzwmc,sfbk,kcsx,fxcj,kkyxmc,',
      _search: 'false', nd: String(Date.now()), 'page.size': '100', 'page.pn': '1',
      sort: 'xnxq desc,id', order: 'desc', startXnxq: '001', endXnxq: '001',
      kcmc: '', sfjg: '', kcxz: '', kclx: '', kclb: '', kcgs: '',
      'query.startXnxq||': '001', 'query.endXnxq||': '001', 'query.kcmc||': '',
      'query.sfjg||': '', 'query.kcxz||': '', 'query.kclx||': '', 'query.kclb||': '', 'query.kcgs||': '',
    })
    const cj = await ses.fetch(`${JW_BASE}/admin/xsd/xsdcjcx/xsdQueryXscjList?fxbz=0&gridtype=jqgrid`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' },
      body: gradeBody.toString(),
    })
    const cjJson = JSON.parse(await cj.text())
    console.log('成绩:', cjJson.ret === 0 ? `共 ${cjJson.total} 门，最新 ${cjJson.results?.[0]?.kcmc}（${cjJson.results?.[0]?.zhcj}）` : `ret=${cjJson.ret}`)

    const examBody = new URLSearchParams({
      queryFields: 'id,kspcmc,xh,xm,kcmc,kssj,jsmc,ksfs,ksxs,zwh,bkcs,bz,rwbz,',
      _search: 'false', nd: String(Date.now()), 'page.size': '100', 'page.pn': '1',
      sort: 'bjdm asc,zwh asc,id', order: 'asc', xnxq: semester, pcid: '',
      'query.xnxq||': semester, 'query.pcid||': '',
    })
    const ks = await ses.fetch(`${JW_BASE}/admin/xsd/kwglXsdKscx/ajaxXsksList?gridtype=jqgrid`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' },
      body: examBody.toString(),
    })
    const ksJson = JSON.parse(await ks.text())
    console.log('考试:', ksJson.ret === 0 ? `${ksJson.results?.length ?? 0} 场` : `ret=${ksJson.ret}`)

    const tz = await ses.fetch(`${JW_BASE}/admin/system/showHomeView/getNoticeSysjlist`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    const tzJson = JSON.parse(await tz.text())
    console.log('通知:', `${tzJson.list?.length ?? 0} 条，最新「${tzJson.list?.[0]?.title}」`)

    // 步骤7: 完整课表链路（真实课表页同款三步：grdb 子集 → 页面抠 xhid → sdpkkbList 全量）
    console.log('\n===== 步骤7: 完整课表链路 =====')
    const grdbRes = await ses.fetch(`${JW_BASE}/admin/pkgl/xskb/queryKbForGrdb`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    const grdbRows = JSON.parse(await grdbRes.text()).data || []
    console.log('grdb 个人子集:', grdbRows.length, '行 /', new Set(grdbRows.map((r) => r.kcmc)).size, '门课')
    const kbPage = await ses.fetch(`${JW_BASE}/admin/xsd/pkgl/xskb/queryKbForXsd?xnxq=2026-2027-1&xskbxslx=0`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    const kbHtml = await kbPage.text()
    const xhid = /id="xhid"\s+value="([^"]+)"/.exec(kbHtml)?.[1]
    console.log('xhid:', xhid ? xhid.slice(0, 24) + '…' : '未找到!')
    const xqdm = grdbRows[0]?.xqid ?? ''
    const sdRes = await ses.fetch(
      `${JW_BASE}/admin/xsd/pkgl/xskb/sdpkkbList?xnxq=2026-2027-1&xhid=${xhid}&xqdm=${xqdm}&zdzc=&zxzc=&xskbxslx=0`,
      { headers: { 'X-Requested-With': 'XMLHttpRequest' } },
    )
    const sdRows = JSON.parse(await sdRes.text()).data || []
    const sdCourses = new Set(sdRows.map((r) => String(r.kcmc).replace(/<[^>]+>/g, '')))
    console.log('sdpkkbList 全量:', sdRows.length, '行 /', sdCourses.size, '门课')
    console.log('课程清单:', [...sdCourses].join(' / '))
    console.log('带节次(djc)行数:', sdRows.filter((r) => r.djc > 0).length)

    console.log('\n===== 全链路完成 ✅ =====')
  } catch (err) {
    console.log('\n[异常]', err?.message ?? String(err))
    console.log(err?.stack?.split('\n').slice(0, 4).join('\n'))
  }
  app.quit()
})
