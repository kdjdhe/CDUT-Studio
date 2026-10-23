/**
 * cdu-dashboard.tsx — CDU 专区展示结构
 *
 * 层级与学校真实入口一致：
 *   统一身份认证（账户框架）
 *     ├─ 数智教务（szjw.cdu.edu.cn）
 *     └─ ISP 学生综合服务平台（xsswzx.cdu.edu.cn）
 *
 * 偏好按学号隔离保存在渲染进程本地存储，只影响展示，不改变抓取与缓存策略。
 */

import type { LucideIcon } from 'lucide-react'
import {
  Bell,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  GraduationCap,
  HeartHandshake,
  Megaphone,
  Wallet,
} from 'lucide-react'

export type CduDashboardServiceId = 'jw' | 'isp'

export type CduDashboardComponentId =
  | 'jw.timetable'
  | 'jw.grades'
  | 'jw.exams'
  | 'jw.notices'
  | 'isp.notices'
  | 'isp.score'
  | 'isp.books'
  | 'isp.family'

export interface CduDashboardServiceMeta {
  id: CduDashboardServiceId
  title: string
  subtitle: string
  hint: string
  icon: LucideIcon
}

export interface CduDashboardComponentMeta {
  id: CduDashboardComponentId
  service: CduDashboardServiceId
  title: string
  description: string
  icon: LucideIcon
}

export interface CduDashboardPrefs {
  version: 1
  /** 每个子服务内部的展示顺序（包含隐藏项，便于用户随时恢复） */
  order: Record<CduDashboardServiceId, CduDashboardComponentId[]>
  hidden: CduDashboardComponentId[]
}

export const CDU_DASHBOARD_SERVICES: CduDashboardServiceMeta[] = [
  {
    id: 'jw',
    title: '数智教务',
    subtitle: 'szjw.cdu.edu.cn',
    hint: '课表 · 成绩 · 考试 · 通知',
    icon: GraduationCap,
  },
  {
    id: 'isp',
    title: 'ISP 学生综合服务平台',
    subtitle: 'xsswzx.cdu.edu.cn',
    hint: '通知 · 素质分 · 图书 · 困难认定',
    icon: HeartHandshake,
  },
]

export const CDU_DASHBOARD_COMPONENTS: Record<CduDashboardComponentId, CduDashboardComponentMeta> = {
  'jw.timetable': {
    id: 'jw.timetable',
    service: 'jw',
    title: '我的课表',
    description: '课程、教室、教师、周次与节次',
    icon: CalendarDays,
  },
  'jw.grades': {
    id: 'jw.grades',
    service: 'jw',
    title: '我的成绩',
    description: '学期成绩、学分与绩点',
    icon: ClipboardList,
  },
  'jw.exams': {
    id: 'jw.exams',
    service: 'jw',
    title: '考试安排',
    description: '考试时间、考场与座位',
    icon: Bell,
  },
  'jw.notices': {
    id: 'jw.notices',
    service: 'jw',
    title: '教务通知',
    description: '教务处最新通知',
    icon: Bell,
  },
  'isp.notices': {
    id: 'isp.notices',
    service: 'isp',
    title: 'ISP 通知',
    description: '学生事务服务中心通知',
    icon: Megaphone,
  },
  'isp.score': {
    id: 'isp.score',
    service: 'isp',
    title: '素质分',
    description: '月度素质分与加分明细',
    icon: ClipboardCheck,
  },
  'isp.books': {
    id: 'isp.books',
    service: 'isp',
    title: '图书借阅',
    description: '在借书目、到期日与剩余天数',
    icon: BookOpen,
  },
  'isp.family': {
    id: 'isp.family',
    service: 'isp',
    title: '家庭经济困难认定',
    description: '申报任务与学年认定结果',
    icon: Wallet,
  },
}

const ALL_COMPONENTS: CduDashboardComponentId[] = [
  'jw.timetable',
  'jw.grades',
  'jw.exams',
  'jw.notices',
  'isp.score',
  'isp.books',
  'isp.family',
  'isp.notices',
]

const SERVICE_COMPONENTS: Record<CduDashboardServiceId, CduDashboardComponentId[]> = {
  jw: ALL_COMPONENTS.filter((id) => CDU_DASHBOARD_COMPONENTS[id].service === 'jw'),
  isp: ALL_COMPONENTS.filter((id) => CDU_DASHBOARD_COMPONENTS[id].service === 'isp'),
}

export const CDU_DEFAULT_PREFS: CduDashboardPrefs = {
  version: 1,
  order: {
    jw: [...SERVICE_COMPONENTS.jw],
    isp: [...SERVICE_COMPONENTS.isp],
  },
  hidden: [],
}

function isComponentId(value: unknown): value is CduDashboardComponentId {
  return typeof value === 'string' && value in CDU_DASHBOARD_COMPONENTS
}

/** 兼容旧配置/手工改坏的 localStorage：去重、丢弃未知项、补齐缺失组件。 */
export function normalizeCduDashboardPrefs(raw: unknown): CduDashboardPrefs {
  const source = raw && typeof raw === 'object' ? (raw as Partial<CduDashboardPrefs>) : {}
  const hidden = Array.isArray(source.hidden)
    ? [...new Set(source.hidden.filter(isComponentId))]
    : []
  const order = {} as CduDashboardPrefs['order']
  for (const service of CDU_DASHBOARD_SERVICES) {
    const requested = Array.isArray(source.order?.[service.id]) ? source.order[service.id] : []
    const seen = new Set<CduDashboardComponentId>()
    const next: CduDashboardComponentId[] = []
    for (const id of requested) {
      if (!isComponentId(id) || CDU_DASHBOARD_COMPONENTS[id].service !== service.id || seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
    for (const id of SERVICE_COMPONENTS[service.id]) {
      if (!seen.has(id)) next.push(id)
    }
    order[service.id] = next
  }
  return { version: 1, order, hidden }
}

/** 在子服务内上移/下移一个组件。 */
export function moveCduDashboardComponent(
  prefs: CduDashboardPrefs,
  service: CduDashboardServiceId,
  id: CduDashboardComponentId,
  delta: -1 | 1,
): CduDashboardPrefs {
  const list = [...prefs.order[service]]
  const index = list.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return prefs
  ;[list[index], list[target]] = [list[target]!, list[index]!]
  return { ...prefs, order: { ...prefs.order, [service]: list } }
}

/** 把组件拖到子服务内的指定位置（toIndex 为最终下标）。 */
export function reorderCduDashboardComponent(
  prefs: CduDashboardPrefs,
  service: CduDashboardServiceId,
  id: CduDashboardComponentId,
  toIndex: number,
): CduDashboardPrefs {
  const list = [...prefs.order[service]]
  const fromIndex = list.indexOf(id)
  if (fromIndex < 0 || toIndex < 0 || toIndex >= list.length || fromIndex === toIndex) return prefs
  const [moved] = list.splice(fromIndex, 1)
  if (!moved) return prefs
  list.splice(toIndex, 0, moved)
  return { ...prefs, order: { ...prefs.order, [service]: list } }
}

export function setCduDashboardComponentVisible(
  prefs: CduDashboardPrefs,
  id: CduDashboardComponentId,
  visible: boolean,
): CduDashboardPrefs {
  const hidden = new Set(prefs.hidden)
  if (visible) hidden.delete(id)
  else hidden.add(id)
  return { ...prefs, hidden: [...hidden] }
}

export function setCduDashboardServiceVisible(
  prefs: CduDashboardPrefs,
  service: CduDashboardServiceId,
  visible: boolean,
): CduDashboardPrefs {
  const ids = SERVICE_COMPONENTS[service]
  const hidden = new Set(prefs.hidden)
  for (const id of ids) {
    if (visible) hidden.delete(id)
    else hidden.add(id)
  }
  return { ...prefs, hidden: [...hidden] }
}

/** 当前子服务下按用户顺序排列、且未被隐藏的组件。 */
export function visibleCduDashboardComponents(
  prefs: CduDashboardPrefs,
  service: CduDashboardServiceId,
): CduDashboardComponentId[] {
  const hidden = new Set(prefs.hidden)
  return prefs.order[service].filter((id) => !hidden.has(id))
}
