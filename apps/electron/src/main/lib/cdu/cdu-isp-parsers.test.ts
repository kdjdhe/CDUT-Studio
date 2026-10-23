import { describe, expect, test } from 'bun:test'
import { parseNotices } from './cdu-isp-parsers'

describe('ISP 通知解析', () => {
  test('保留通知详情链接并解析为绝对地址', () => {
    const html = `
      <table>
        <tr>
          <td>
            发布时间：2026-10-20
            通知标题：<a href="/ispstu/com_user/notice_detail.asp?id=abc123">关于开展综合素质测评的通知</a>【点击阅读】
            通知来源：学生处 未阅读
          </td>
        </tr>
      </table>
    `
    const notices = parseNotices(html)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.title).toBe('关于开展综合素质测评的通知')
    expect(notices[0]?.url).toBe(
      'https://xsswzx.cdu.edu.cn/ispstu/com_user/notice_detail.asp?id=abc123',
    )
    expect(notices[0]?.read).toBe(false)
  })

  test('通知行没有链接时不伪造详情地址', () => {
    const html = `
      <table>
        <tr>
          <td>
            发布时间：2026-10-19
            通知标题：普通通知【点击阅读】
            通知来源：学生处 已阅读
          </td>
        </tr>
      </table>
    `
    const notices = parseNotices(html)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.url).toBeUndefined()
    expect(notices[0]?.read).toBe(true)
  })
})
