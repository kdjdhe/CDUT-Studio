/**
 * ISP 页面 HTML 解析器（纯函数，无 Electron 依赖，便于离线用真实抓包回归验证）
 *
 * 全部正则按 2026-10-11 实抓页面结构编写：
 *   - 通知行：发布时间：… 通知标题：…【点击阅读】 通知来源：… 已阅读/未阅读
 *   - 素质分：逐月行 img/N.png + 隐藏字段 value="<ol><li>项目（分）" id="grN"
 *   - 图书：表头含 图书名称|馆藏与图书|日期|阅读反馈 的表格
 *   - 困难认定：标签值对（认定学年：/申请时间：/认定结果：）+ 申报任务行
 */

import type {
  CduIspBook,
  CduIspFamilyAssessment,
  CduIspFamilyData,
  CduIspNotice,
  CduIspScoreData,
  CduIspScoreItem,
  CduIspScoreMonth,
} from '@profer/shared'

/** HTML 实体与标签清理 */
export function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t\u00a0]+/g, ' ')
}

/** 按行切分纯文本（去空行） */
export function textLines(html: string): string[] {
  return stripTags(html)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 解析个人借阅书目表（特征：表头为 图书名称|馆藏与图书|日期|阅读反馈 的那张表） */
export function parseBooks(html: string): CduIspBook[] {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? []
  const target = tables.find((t) => t.includes('图书名称') && t.includes('阅读反馈'))
  if (!target) return []
  const rows = [...target.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? '')
  const books: CduIspBook[] = []
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '')
    if (cells.length < 3) continue
    const title = stripTags(cells[0] ?? '').trim()
    if (!title || title === '图书名称') continue
    const dateText = stripTags(cells[2] ?? '')
    const remaining = /【还剩(\d+)日】/.exec(dateText)?.[1]
    books.push({
      title,
      location: stripTags(cells[1] ?? '').replace(/\s+/g, ' ').trim(),
      borrowDate: /借阅日：\s*([\d-]+)/.exec(dateText)?.[1],
      dueDate: /到期日：\s*([\d-]+)/.exec(dateText)?.[1],
      remainingDays: remaining != null ? `还剩${remaining}日` : undefined,
    })
  }
  return books
}

/** 解析素质分明细（逐月行 + 隐藏字段里的 <li>项目（分） 列表） */
export function parseScore(html: string): CduIspScoreData {
  const data: CduIspScoreData = { months: [] }
  // 页面 rowspan 单元格：当前月 + 达标状态（size=8 大字月份）
  const currentMatch = />(\d{1,2})<\/font>[^<]*<[^>]*>\s*(已达标|未达标)/.exec(html.replace(/\s+/g, ' '))
    ?? /size=8[^>]*>(\d{1,2})<\/font>[\s\S]{0,200}?(已达标|未达标)/.exec(html.replace(/\s+/g, ' '))
  if (currentMatch) {
    data.currentMonth = Number(currentMatch[1])
    data.status = currentMatch[2]
  }
  // 逐月行：img/N.png 标识月份；得分与 hidden 明细随行
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? '')
  for (const row of rows) {
    const monthMatch = /img\/(\d{1,2})\.png/.exec(row)
    if (!monthMatch) continue
    const month = Number(monthMatch[1])
    // 单元格顺序：月份图 | 得分 | 个人申请分(含hidden明细) | 部门加减分 | Detail
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1] ?? '').replace(/\s+/g, ' ').trim())
    const monthItem: CduIspScoreMonth = { month, items: [] }
    if (/^\d+(\.\d+)?$/.test(cells[1] ?? '')) {
      monthItem.score = cells[1] ?? undefined
    }
    // 个人申请分单元格以数字开头（hidden 明细文本紧随其后）
    const applied = /^\s*([0-9.]+)/.exec(cells[2] ?? '')
    if (applied) monthItem.appliedScore = applied[1]
    if (/^\d+(\.\d+)?$/.test(cells[3] ?? '')) {
      monthItem.deptScore = cells[3] ?? undefined
    }
    // hidden 明细：value="<ol>...<li>项目（分）..." id="grN"
    const grantMatch = /value="([\s\S]*?)"\s*id="gr(\d+)"/.exec(row)
    if (grantMatch && Number(grantMatch[2]) === month) {
      const items: CduIspScoreItem[] = []
      const listText = (grantMatch[1] ?? '').replace(/<br\s*\/?>/gi, '\n')
      for (const li of listText.split(/<li>/i).slice(1)) {
        const clean = stripTags(li).replace(/\s+/g, ' ').trim()
        if (!clean) continue
        const scoreMatch = /^(.*?)[（(]([0-9.\-]+)[）)]\s*$/.exec(clean)
        if (scoreMatch) {
          items.push({ name: (scoreMatch[1] ?? '').replace(/^【/, '').trim(), score: scoreMatch[2] ?? '' })
        } else {
          items.push({ name: clean, score: '' })
        }
      }
      monthItem.items = items
    }
    data.months.push(monthItem)
  }
  return data
}

/** 解析首页通知行（发布时间/标题/来源/已读） */
export function parseNotices(html: string): CduIspNotice[] {
  const notices: CduIspNotice[] = []
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? []
  const target = tables.find((t) => t.includes('通知信息') || t.includes('通知标题'))
  if (!target) return notices
  for (const row of target.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const text = stripTags(row[1] ?? '').replace(/\s+/g, ' ')
    const titleMatch = /通知标题：\s*([^【]+?)(?:【点击阅读】)?\s*通知来源：/.exec(text)
    if (!titleMatch) continue
    notices.push({
      title: (titleMatch[1] ?? '').trim(),
      publishDate: /发布时间：\s*([\d-]+)/.exec(text)?.[1],
      source: /通知来源：\s*([^已]*?)(?:已阅读|未阅读)/.exec(text)?.[1]?.trim(),
      read: text.includes('已阅读'),
    })
  }
  return notices
}

/** 解析家庭经济困难认定（申报任务 + 时间窗口 + 逐学年结果） */
export function parseFamily(html: string): CduIspFamilyData {
  const lines = textLines(html)
  const tasks: CduIspFamilyData['tasks'] = []
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^(家庭情况（评估用）|困难认定（申请用）)$/.exec(lines[i] ?? '')
    if (!nameMatch) continue
    // 行序模式：序号 → 年份 → 名称 → 状态
    const year = lines.slice(Math.max(0, i - 2), i).find((l) => /^\d{4}年?$/.test(l) || /^\d{4}-\d{4}学年$/.test(l))
    const status = lines.slice(i + 1, i + 3).find((l) => /已填报|未填报|未开始|已退回/.test(l))
    if (year && status) {
      tasks.push({ year, name: nameMatch[1] ?? '', status })
    }
  }
  const joined = lines.join('\n')
  const windowMatch = /(\d{4}\/\d{1,2}\/\d{1,2}[^|\n]*至\s*\d{4}\/\d{1,2}\/\d{1,2}[^|\n]*)/.exec(joined)
  const assessments: CduIspFamilyAssessment[] = []
  const blocks = joined.split(/认定学年：/).slice(1)
  for (const block of blocks) {
    const year = /^\s*([^\n]+)/.exec(block)?.[1]?.trim()
    if (!year) continue
    assessments.push({
      year,
      applyTime: /申请时间：\s*([^\n]+)/.exec(block)?.[1]?.trim(),
      result: /认定结果：\s*([^\n]+)/.exec(block)?.[1]?.trim(),
    })
  }
  return { tasks, window: windowMatch?.[1]?.trim(), assessments }
}
