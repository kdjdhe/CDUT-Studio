/**
 * CDU 数智教务系统（szjw.cdu.edu.cn，正方系）底层客户端
 *
 * 职责：
 *   - 基于 persist:cdu-zone 分区 Session 的统一请求器（会话 Cookie 自动携带）；
 *   - 封装学生端只读业务域：课表 / 成绩 / 考试安排 / 教务通知 / 节次时间；
 *   - fetchOverview 一次性聚合全部业务域，单域失败不阻断整体（partialErrors 上报）。
 *
 * 范围声明（如实标注，不做过度承诺）：
 *   - 本模块仅负责发起 HTTP 与解析，不持有明文密码、不嗅探 Cookie；
 *   - 仅实现学生端只读查询；选课/报名等写操作按安全红线不在客户端实现；
 *   - 空教室查询依赖全校课表（sdpkkbList 需加密 xhid 参数），暂未纳入，待后续版本。
 */

import { session } from 'electron'
import type {
  CduCalendarWeek,
  CduCourseItem,
  CduExamItem,
  CduGradeItem,
  CduNoticeItem,
  CduOverviewData,
  CduPeriodItem,
} from '@profer/shared'
import { CDU_SESSION_PARTITION } from './cdu-auth-manager'
import { getCachedCduData, getCduOverviewFreshness, setCachedCduData } from './cdu-cache'

/** 数智教务站点根，所有业务端点均挂载其下 */
const CDU_JW_BASE = 'https://szjw.cdu.edu.cn'

/** 会话失效（业务请求被 302 回 CAS 域）专用错误 */
class CduSessionExpiredError extends Error {
  constructor() {
    super('教务会话已失效，请重新登录')
    this.name = 'CduSessionExpiredError'
  }
}

/** 周次串展开："1-2,5-6,9-11" → [1,2,5,6,9,10,11] */
function expandWeeks(zcstr?: string): number[] {
  if (!zcstr) return []
  const result: number[] = []
  for (const part of zcstr.split(',')) {
    const segment = part.trim()
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] ?? '', 10)
      const end = Number.parseInt(rangeMatch[2] ?? '', 10)
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        for (let i = start; i <= end; i++) result.push(i)
      }
    } else {
      const value = Number.parseInt(segment, 10)
      if (Number.isFinite(value)) result.push(value)
    }
  }
  return result
}

/** 成绩课程名形如 "[67410051]思想政治理论课实践教学（1）"，拆出课程代码与名称 */
function splitCourseName(raw: string): { code?: string; name: string } {
  const matched = raw.match(/^\[([^\]]+)\](.+)$/)
  const code = matched?.[1]
  const name = matched?.[2]
  if (code && name) {
    return { code, name }
  }
  return { name: raw }
}

/** 统一业务响应壳（getCurrentRole / 课表 / 节次 等） */
interface JwEnvelope<T> {
  ret: number
  msg?: string
  data?: T
}

/** jqGrid 分页响应壳（成绩 / 考试） */
interface JqGridEnvelope<T> {
  ret: number
  msg?: string
  page?: number
  rows?: number
  total?: number
  totalPages?: number
  results?: T[]
}

/** 原始课表行（仅映射业务字段，其余服务端冗余字段忽略） */
interface RawCourseRow {
  id?: string
  pkid?: string
  tid?: string
  djc?: number
  kcmc?: string
  kcbh?: string
  tmc?: string
  croommc?: string
  croombh?: string
  zc?: string
  zcstr?: string
  xingqi?: number
  xjc?: number
  jsxq?: string
  xqid?: string
  xf?: string
  kcxz?: string
  ksxs?: string
  jxbmc?: string
  bjrs?: string
}

/** 原始成绩行 */
interface RawGradeRow {
  id?: string
  xnxq?: string
  kcmc?: string
  kcbh?: string
  zhcj?: string
  xf?: string
  hdxf?: string | number
  xfjd?: string
  kcxz?: string
  ksxs?: string
  sfbk?: string
}

/** 原始考试行 */
interface RawExamRow {
  id?: string
  kcmc?: string
  kssj?: string
  jsmc?: string
  zwh?: string
  ksxs?: string
  ksfs?: string
}

/** 原始通知行 */
interface RawNoticeRow {
  id?: string
  title?: string
  releasedate?: string
  releaseDate?: string
  /** 部分版本会直接返回详情地址，字段名不固定，统一兜底 */
  url?: string
  link?: string
  href?: string
  wzlj?: string
}

/** 原始节次行 */
interface RawPeriodRow {
  jc?: string
  kssj?: string
  jssj?: string
  sjd?: string
}

export class CduJwClient {
  /** 分区 Session 统一请求器：JSON 业务接口需携带 X-Requested-With */
  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    // 注意：Electron fetch 的 response.url 恒为空，无法用它判断重定向落点；
    // 会话失效（302 回 CAS 登录页）由 requestJson 的非 JSON 响应检查兜底识别。
    return await ses.fetch(`${CDU_JW_BASE}${pathname}`, {
      ...init,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(init?.headers ?? {}),
      },
    })
  }

  /** 解析 JSON 业务响应；非 JSON（如被重定向到登录页 HTML）一律按会话失效处理 */
  private async requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await this.request(pathname, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      throw new CduSessionExpiredError()
    }
    return (await response.json()) as T
  }

  /** 当前学年学期（如 2026-2027-1） */
  public async getCurrentSemester(): Promise<string> {
    const payload = await this.requestJson<JwEnvelope<{ dataXnxq?: string }>>('/admin/api/jcsj/xnxq/getCurrentXnxq')
    return payload.data?.dataXnxq ?? ''
  }

  /** 去除教务返回文本中的 HTML 标签（sdpkkbList 的课程名/教室/教师带 <a> 链接） */
  private stripHtml(raw: string): string {
    return raw.replace(/<[^>]+>/g, '').trim()
  }

  /** 拉取页面 HTML（非 JSON 接口；CAS 登录页特征即会话失效） */
  private async requestHtml(pathname: string): Promise<string> {
    const ses = session.fromPartition(CDU_SESSION_PARTITION)
    const response = await ses.fetch(`${CDU_JW_BASE}${pathname}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    const html = await response.text()
    if (html.includes('login-page-flowkey')) {
      throw new CduSessionExpiredError()
    }
    return html
  }

  /**
   * 完整学生课表（对齐真实课表页的三步链，缺一不可）：
   *   1. queryKbForGrdb        → 行政班共同课（仅子集，约 5 门）+ 校区 id；
   *   2. queryKbForXsd 页面壳   → 抠隐藏域 xhid（学生专属加密 id，每生固定）；
   *   3. sdpkkbList            → 全量排课课表（12 门，含体育/选修/实验），
   *     每行 = 一个单节次块（djc = 节次号；同 tid 连号 djc 即连堂，由渲染层合并）。
   * 任一步失败即回退第 1 步的个人子集，并在 source 中如实标注。
   */
  public async queryTimetable(semester: string): Promise<{ items: CduCourseItem[]; source: 'full' | 'fallback' }> {
    const mapGrdbRow = (row: RawCourseRow): CduCourseItem => ({
      id: row.id ?? '',
      courseName: this.stripHtml(row.kcmc ?? ''),
      courseCode: row.kcbh,
      teacher: this.stripHtml(row.tmc ?? '') || undefined,
      classroom: this.stripHtml(row.croommc ?? '') || this.stripHtml(row.croombh ?? '') || undefined,
      weeks: row.zc,
      weekNums: expandWeeks(row.zcstr ?? row.zc),
      weekday: row.xingqi ?? 0,
      campus: this.stripHtml(row.jsxq ?? '') || undefined,
      campusId: row.xqid,
      credits: row.xf,
      courseCategory: row.kcxz,
      examType: row.ksxs,
      teachingClass: this.stripHtml(row.jxbmc ?? '') || undefined,
      classSize: row.bjrs,
    })
    const fallback = async (): Promise<{ items: CduCourseItem[]; source: 'fallback' }> => {
      const payload = await this.requestJson<JwEnvelope<RawCourseRow[]>>('/admin/pkgl/xskb/queryKbForGrdb')
      return { items: (payload.data ?? []).map(mapGrdbRow), source: 'fallback' }
    }

    if (!semester) return await fallback()
    try {
      // 1. 个人课表：拿校区 id（xqdm）并保留为兜底
      const grdbPayload = await this.requestJson<JwEnvelope<RawCourseRow[]>>('/admin/pkgl/xskb/queryKbForGrdb')
      const campusId = grdbPayload.data?.[0]?.xqid
      // 2. 课表页面壳抠 xhid
      const pageHtml = await this.requestHtml(
        `/admin/xsd/pkgl/xskb/queryKbForXsd?xnxq=${encodeURIComponent(semester)}&xskbxslx=0`,
      )
      const xhid = /id="xhid"\s+value="([^"]+)"/.exec(pageHtml)?.[1]
      if (!xhid) {
        return { items: (grdbPayload.data ?? []).map(mapGrdbRow), source: 'fallback' }
      }
      // 3. 全量排课课表
      const payload = await this.requestJson<JwEnvelope<RawCourseRow[]>>(
        `/admin/xsd/pkgl/xskb/sdpkkbList?xnxq=${encodeURIComponent(semester)}&xhid=${encodeURIComponent(xhid)}` +
        `&xqdm=${encodeURIComponent(campusId ?? '')}&zdzc=&zxzc=&xskbxslx=0`,
      )
      const rows = payload.data ?? []
      if (rows.length === 0) {
        return { items: (grdbPayload.data ?? []).map(mapGrdbRow), source: 'fallback' }
      }
      return {
        items: rows.map((row) => ({
          id: `${row.pkid ?? row.id ?? ''}-${row.tid ?? ''}-${row.djc ?? ''}`,
          courseName: this.stripHtml(row.kcmc ?? ''),
          courseCode: row.kcbh,
          teacher: this.stripHtml(row.tmc ?? '') || undefined,
          classroom: this.stripHtml(row.croommc ?? '') || this.stripHtml(row.croombh ?? '') || undefined,
          weeks: row.zc,
          weekNums: expandWeeks(row.zcstr ?? row.zc),
          weekday: row.xingqi ?? 0,
          period: Number(row.djc) > 0 ? Number(row.djc) : undefined,
          campus: this.stripHtml(row.jsxq ?? '') || undefined,
          campusId: row.xqid,
          credits: row.xf,
          courseCategory: row.kcxz,
          examType: row.ksxs,
          teachingClass: this.stripHtml(row.jxbmc ?? '') || undefined,
          classSize: row.bjrs,
        })),
        source: 'full',
      }
    } catch (error) {
      if (error instanceof CduSessionExpiredError) throw error
      return await fallback()
    }
  }

  /** 节次时间表（xqid 取自课表行；无课表时返回空） */
  public async queryPeriods(semester: string, campusId?: string): Promise<CduPeriodItem[]> {
    if (!semester || !campusId) return []
    const payload = await this.requestJson<JwEnvelope<{ jcsjszList?: RawPeriodRow[] }>>(
      `/admin/api/getZclistByXnxq?xnxq=${encodeURIComponent(semester)}&role=&userId=&xqid=${encodeURIComponent(campusId)}`,
    )
    return (payload.data?.jcsjszList ?? []).map((row) => ({
      period: row.jc ?? '',
      start: row.kssj,
      end: row.jssj,
      section: row.sjd,
    }))
  }

  /**
   * 校历（xlgl/getData）：按周聚合 7 天公历日期，供课表横轴标注月/日。
   * 注意：同一周跨月时接口会拆成多行（如 8月周一 + 9月周二~周日 同为 zc:0），须按 zc 合并。
   */
  public async queryCalendar(semester: string): Promise<CduCalendarWeek[]> {
    if (!semester) return []
    interface RawCalendarRow {
      ny?: string
      zc?: string
      monday?: string
      tuesday?: string
      wednesday?: string
      thursday?: string
      friday?: string
      saturday?: string
      sunday?: string
    }
    const rows = await this.requestJson<RawCalendarRow[]>(
      `/admin/xsd/jcsj/xlgl/getData/${encodeURIComponent(semester)}`,
    )
    const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
    // week → (weekday → { 年月, 日号 })
    const byWeek = new Map<number, Map<number, { yearMonth: string; day: string }>>()
    for (const row of rows) {
      const week = Number(row.zc)
      if (!Number.isFinite(week) || !row.ny) continue
      const days = byWeek.get(week) ?? new Map<number, { yearMonth: string; day: string }>()
      dayKeys.forEach((key, index) => {
        const day = row[key]
        if (day != null && day !== '') days.set(index + 1, { yearMonth: row.ny as string, day })
      })
      byWeek.set(week, days)
    }
    const formatDate = (year: number, month: number, day: number): string => {
      const date = new Date(year, month - 1, day)
      if (Number.isNaN(date.getTime())) return ''
      const mm = String(date.getMonth() + 1).padStart(2, '0')
      const dd = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${mm}-${dd}`
    }
    return [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([week, days]) => {
        const dates: (string | null)[] = [null]
        for (let weekday = 1; weekday <= 7; weekday++) {
          const item = days.get(weekday)
          if (!item) {
            dates.push(null)
            continue
          }
          const yearMonth = item.yearMonth.split('-')
          const year = Number(yearMonth[0])
          const month = Number(yearMonth[1] ?? '0')
          dates.push(Number.isFinite(year) && Number.isFinite(month) ? formatDate(year, month, Number(item.day)) || null : null)
        }
        return { week, dates }
      })
  }

  /**
   * 全量成绩（jqGrid 分页协议，startXnxq=001 为通配起始学期）
   * 页数上限硬熔断 10 页，防止接口异常时的无限翻页。
   */
  public async queryAllGrades(): Promise<{ items: CduGradeItem[]; total: number }> {
    const items: CduGradeItem[] = []
    let total = 0
    const maxPages = 10
    for (let page = 1; page <= maxPages; page++) {
      const body = new URLSearchParams({
        queryFields: 'id,xnxq,kcmc,xf,kcxz,kclx,ksxs,kcgs,xdxz,kclb,cjfxms,zhcj,jd,hdxf,tscjzwmc,sfbk,kcsx,fxcj,kkyxmc,',
        _search: 'false',
        nd: String(Date.now()),
        'page.size': '100',
        'page.pn': String(page),
        sort: 'xnxq desc,id',
        order: 'desc',
        startXnxq: '001',
        endXnxq: '001',
        kcmc: '',
        sfjg: '',
        kcxz: '',
        kclx: '',
        kclb: '',
        kcgs: '',
        'query.startXnxq||': '001',
        'query.endXnxq||': '001',
        'query.kcmc||': '',
        'query.sfjg||': '',
        'query.kcxz||': '',
        'query.kclx||': '',
        'query.kclb||': '',
        'query.kcgs||': '',
      })
      const payload = await this.requestJson<JqGridEnvelope<RawGradeRow>>(
        '/admin/xsd/xsdcjcx/xsdQueryXscjList?fxbz=0&gridtype=jqgrid',
        { method: 'POST', body: body.toString() },
      )
      total = payload.total ?? total
      for (const row of payload.results ?? []) {
        const { code, name } = splitCourseName(row.kcmc ?? '')
        items.push({
          id: row.id ?? '',
          semester: row.xnxq ?? '',
          courseName: name,
          courseCode: row.kcbh ?? code,
          totalScore: row.zhcj ?? '',
          credit: row.xf ?? (row.hdxf != null ? String(row.hdxf) : undefined),
          gpaPoint: row.xfjd,
          earnedCredit: row.hdxf != null ? String(row.hdxf) : undefined,
          courseCategory: row.kcxz,
          examType: row.ksxs,
        })
      }
      const totalPages = payload.totalPages ?? 1
      if (totalPages <= page) break
    }
    return { items, total }
  }

  /** 考试安排（按学期查询） */
  public async queryExams(semester: string): Promise<CduExamItem[]> {
    const body = new URLSearchParams({
      queryFields: 'id,kspcmc,xh,xm,kcmc,kssj,jsmc,ksfs,ksxs,zwh,bkcs,bz,rwbz,',
      _search: 'false',
      nd: String(Date.now()),
      'page.size': '100',
      'page.pn': '1',
      sort: 'bjdm asc,zwh asc,id',
      order: 'asc',
      xnxq: semester,
      pcid: '',
      'query.xnxq||': semester,
      'query.pcid||': '',
    })
    const payload = await this.requestJson<JqGridEnvelope<RawExamRow>>(
      '/admin/xsd/kwglXsdKscx/ajaxXsksList?gridtype=jqgrid',
      { method: 'POST', body: body.toString() },
    )
    return (payload.results ?? []).map((row) => ({
      id: row.id ?? '',
      courseName: row.kcmc ?? '',
      time: row.kssj,
      room: row.jsmc,
      seat: row.zwh,
      examType: row.ksxs,
      examForm: row.ksfs,
    }))
  }

  /** 教务通知（响应无统一 ret 壳，直接是 { list }） */
  public async queryNotices(): Promise<CduNoticeItem[]> {
    const payload = await this.requestJson<{ list?: RawNoticeRow[] }>('/admin/system/showHomeView/getNoticeSysjlist')
    return (payload.list ?? []).map((row) => {
      const rawUrl = row.url ?? row.link ?? row.href ?? row.wzlj
      // 只接受绝对地址或以 / 开头的站内路径；裸 id 不猜详情路由。
      const url = rawUrl && (/^(?:https?:)?\/\//i.test(rawUrl) || rawUrl.startsWith('/'))
        ? new URL(rawUrl, `${CDU_JW_BASE}/admin/`).toString()
        : undefined
      return {
        id: row.id ?? '',
        title: row.title ?? '',
        releaseDate: row.releaseDate ?? row.releasedate,
        url,
      }
    })
  }

  /**
   * 一站式聚合：课表 + 成绩 + 考试 + 通知 + 节次时间 + 校历周次。
   * 分级 TTL 合并：课表/节次/校历 24h、成绩/考试 1h、通知/学期/周次 10min——
   * 各域独立判定新鲜度，只重爬过期域（课表这类低频变化数据一天至多爬一次）。
   * force=true（用户点刷新）绕过全部分级缓存整体重爬。
   * 单域失败不阻断整体，错误收敛进 partialErrors。
   */
  public async fetchOverview(force = false): Promise<CduOverviewData> {
    if (!force) {
      const cached = getCachedCduData<CduOverviewData>('overview', Number.POSITIVE_INFINITY)
      if (cached) {
        const fresh = getCduOverviewFreshness(cached)
        const allFresh = fresh.timetable && fresh.academic && fresh.news
        if (allFresh) return cached
        // 部分域过期：先拿「上一份快照」做底，只重爬过期域后覆盖落盘
        const base = cached
        const partialErrors: string[] = []
        const collect = async <T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> => {
          try {
            return await task()
          } catch (error) {
            if (error instanceof CduSessionExpiredError) throw error
            partialErrors.push(`${label}查询失败：${error instanceof Error ? error.message : String(error)}`)
            return fallback
          }
        }
        // 资讯级域（10min）：学期/通知/校历周次（周次与学期绑定，跟随资讯级刷新）
        // 学业级域（1h）：成绩/考试
        // 课表级域（24h）：课表/节次/校历日期表
        let semester = base.semester
        if (!fresh.news) {
          semester = await collect('学期', () => this.getCurrentSemester(), base.semester)
        }
        let timetable = base.timetable
        let periods = base.periods
        let calendar = base.calendar ?? []
        if (!fresh.timetable) {
          const timetableResult = await collect('课表', () => this.queryTimetable(semester), {
            items: base.timetable,
            source: 'fallback' as const,
          })
          timetable = timetableResult.items
          if (timetableResult.source === 'fallback' && timetable.length > 0) {
            partialErrors.push('课表为个人子集（全量排课链路失败，可能缺少选修/体育课）')
          }
          periods = await collect('节次', () => this.queryPeriods(semester, timetable[0]?.campusId), base.periods)
          calendar = await collect('校历', () => this.queryCalendar(semester), base.calendar ?? [])
        }
        let grades = { items: base.grades, total: base.gradeTotal }
        let exams = base.exams
        if (!fresh.academic) {
          grades = await collect('成绩', () => this.queryAllGrades(), { items: base.grades, total: base.gradeTotal })
          exams = await collect('考试', () => this.queryExams(semester), base.exams)
        }
        let notices = base.notices
        let currentWeek = base.currentWeek
        if (!fresh.news) {
          notices = await collect('通知', () => this.queryNotices(), base.notices)
          currentWeek = await collect('校历周次', async () => {
            const payload = await this.requestJson<JwEnvelope<{ xlzc?: string }>>('/admin/api/getXlzc')
            const week = Number(payload.data?.xlzc)
            return Number.isFinite(week) && week > 0 ? week : undefined
          }, base.currentWeek)
        }
        const merged: CduOverviewData = {
          fetchedAt: Date.now(),
          semester,
          timetable,
          grades: grades.items,
          gradeTotal: grades.total,
          exams,
          notices,
          periods,
          currentWeek,
          calendar,
          partialErrors,
        }
        setCachedCduData('overview', merged)
        return merged
      }
    }
    const partialErrors: string[] = []
    const collect = async <T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await task()
      } catch (error) {
        if (error instanceof CduSessionExpiredError) throw error
        partialErrors.push(`${label}查询失败：${error instanceof Error ? error.message : String(error)}`)
        return fallback
      }
    }

    // 学期先行（完整课表链的 queryKbForXsd / sdpkkbList 都需要它）
    const semesterRaw = await collect('学期', () => this.getCurrentSemester(), '')
    const timetableResult = await collect('课表', () => this.queryTimetable(semesterRaw), {
      items: [] as CduCourseItem[],
      source: 'fallback' as const,
    })
    const timetable = timetableResult.items
    if (timetableResult.source === 'fallback' && timetable.length > 0) {
      partialErrors.push('课表为个人子集（全量排课链路失败，可能缺少选修/体育课）')
    }
    const grades = await collect('成绩', () => this.queryAllGrades(), { items: [], total: 0 })
    const exams = await collect('考试', () => this.queryExams(semesterRaw), [])
    const notices = await collect('通知', () => this.queryNotices(), [])
    // 节次时间需要校区 id（xqid），取自课表首行；无课表数据时跳过该域，不影响主数据
    const periods = await collect('节次', () => this.queryPeriods(semesterRaw, timetable[0]?.campusId), [])
    // 校历当前周次（课表默认定位本周的官方依据）
    const currentWeek = await collect('校历周次', async () => {
      const payload = await this.requestJson<JwEnvelope<{ xlzc?: string }>>('/admin/api/getXlzc')
      const week = Number(payload.data?.xlzc)
      return Number.isFinite(week) && week > 0 ? week : undefined
    }, undefined)
    // 校历周次日期表（课表横轴标注月/日）
    const calendar = await collect('校历', () => this.queryCalendar(semesterRaw), [])

    const data: CduOverviewData = {
      fetchedAt: Date.now(),
      semester: semesterRaw,
      timetable,
      grades: grades.items,
      gradeTotal: grades.total,
      exams,
      notices,
      periods,
      currentWeek,
      calendar,
      partialErrors,
    }
    setCachedCduData('overview', data)
    return data
  }
}

export const cduJwClient = new CduJwClient()
