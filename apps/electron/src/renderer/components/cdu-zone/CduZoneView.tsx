/**
 * CduZoneView — CDU 专区主界面（成都大学）
 *
 * 结构：顶栏拖拽区 + 主视图（未登录：品牌区 + 登录卡；已登录：账户条 + 教务数据看板）。
 * - 未登录态：左侧品牌愿景（校训 + 能力矩阵），右侧登录悬浮卡片（学号 / 密码 / 记住密码，
 *   主进程纯 HTTP 静默驱动统一身份认证 CAS）。
 * - 已登录态：账户信息条（姓名 / 学号 / 学期 / 状态）+ 四大数据板块
 *   （学期课表 / 全部成绩 / 考试安排 / 教务通知）。
 *
 * 如实标注：状态 `active` 表示最近一次认证成功且后台静默保活心跳正常；
 * 本客户端不嗅探内网 Cookie，密码仅在勾选时经 OS 级加密落盘；
 * 教务数据全部为只读查询，选课等写操作按安全红线不在客户端实现。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  AlertCircle,
  Bell,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  School,
  ShieldCheck,
} from 'lucide-react'
import type { CduAccountProfile, CduMfaQrPayload, CduOverviewData } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { CduIspSections } from './CduIspSections'
import {
  cduAccountAtom,
  cduOverviewAtom,
  cduOverviewErrorAtom,
  cduIspRefreshAtom,
  cduOverviewLoadingAtom,
  cduTimetableWeekAtom,
} from '@/atoms/cdu-atoms'

/** 专区数据源 Tab：教务系统（szjw）/ ISP 服务平台（xsswzx） */
type CduZoneTab = 'jw' | 'isp'

/** 星期标签（index 对齐 weekday 1-7） */
const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 账户状态徽章文案与配色 */
function statusMeta(status: CduAccountProfile['status']): { label: string; className: string } {
  switch (status) {
    case 'active':
      return { label: '已连接', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }
    case 'connecting':
      return { label: '连接中', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
    case 'expired':
      return { label: '已过期', className: 'bg-red-500/15 text-red-600 dark:text-red-400' }
    default:
      return { label: '未连接', className: 'bg-muted text-muted-foreground' }
  }
}

/** 状态徽章 */
function StatusBadge({ status }: { status: CduAccountProfile['status'] }): React.ReactElement {
  const meta = statusMeta(status)
  return (
    <span className={cnBadge(meta.className)}>
      {status === 'connecting' && <Loader2 className="size-3 animate-spin" />}
      {meta.label}
    </span>
  )
}

function cnBadge(extra: string): string {
  return `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${extra}`
}

/**
 * MFA 二次验证面板：渲染主进程转发的 CAS 企业微信扫码二维码。
 * 阶段与图片由主进程推送（onMfaQrUpdated），成功后主进程广播 active 状态
 * 驱动外层视图切换；客户端不解码二维码内容，扫码识别全部由手机企微完成。
 */
function MfaQrPanel({ onCancel }: { onCancel: () => void }): React.ReactElement {
  const [mfa, setMfa] = React.useState<CduMfaQrPayload | null>(null)

  React.useEffect(() => {
    let disposed = false
    // 打开面板先拉快照，再订阅后续推送（避免漏掉中间态）
    void window.electronAPI.cduZone.getMfaQrSnapshot().then((snapshot) => {
      if (!disposed) setMfa(snapshot)
    }).catch(() => undefined)
    const unsubscribe = window.electronAPI.cduZone.onMfaQrUpdated((payload) => {
      if (!disposed) setMfa(payload)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const showQr = mfa?.qrImage && (mfa.phase === 'awaiting-qr' || mfa.phase === 'polling')

  return (
    <div className="space-y-3 text-center">
      <div className="flex flex-col items-center gap-2 pt-1">
        <span className="flex size-10 items-center justify-center rounded-full bg-sky-600/10 text-sky-600 dark:text-sky-400">
          <ShieldCheck className="size-5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">需要二次验证</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            学校已启用统一身份认证二次验证，请用<span className="font-medium text-foreground">企业微信</span>扫码
          </p>
        </div>
      </div>

      <div className="relative mx-auto flex size-52 items-center justify-center overflow-hidden rounded-xl border bg-white p-2">
        {showQr ? (
          <img src={mfa?.qrImage} alt="企业微信扫码二维码" className="size-full" draggable={false} />
        ) : mfa?.phase === 'polling' || mfa?.phase === 'completed' ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-xs">{mfa?.hint ?? '正在完成登录…'}</span>
          </div>
        ) : mfa?.phase === 'idle' && mfa.hint ? (
          <div className="flex flex-col items-center gap-2 px-3 text-red-600 dark:text-red-400">
            <AlertCircle className="size-6" />
            <span className="text-xs leading-relaxed">{mfa.hint}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-xs">正在获取二维码…</span>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        {mfa?.phase === 'polling'
          ? '已在手机上确认，正在完成登录…'
          : '扫码后请在手机企业微信上点击「确认登录」；二维码约 3 分钟过期'}
      </p>

      <Button variant="ghost" size="sm" onClick={onCancel} className="w-full text-muted-foreground">
        返回重新登录
      </Button>
    </div>
  )
}

/** 登录卡（未登录态） */
function LoginCard(): React.ReactElement {
  const [account, setAccount] = useAtom(cduAccountAtom)
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [remember, setRemember] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  /** MFA 二次验证进行中：登录卡切换为二维码面板 */
  const [mfaActive, setMfaActive] = React.useState(false)

  // 载入本地已保存账户（一键填充；密码仅在勾选记住时返回）
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.cduZone.getSavedAccount().then((saved) => {
      if (cancelled) return
      if (saved.hasSaved) {
        setUsername(saved.studentId ?? '')
        if (saved.savedPassword) setPassword(saved.savedPassword)
        setRemember(saved.rememberPassword === true)
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const handleLogin = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI.cduZone.login({ username, password, rememberPassword: remember })
      if (result.mfaRequired) {
        // 密码已验证通过：切换到二维码面板，后续由主进程推送扫码进度
        setMfaActive(true)
      } else if (result.success && result.profile) {
        setAccount(result.profile)
      } else {
        setError(result.error ?? '登录失败，请稍后重试')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleMfaCancel = (): void => {
    window.electronAPI.cduZone.cancelMfa().catch(() => undefined)
    setMfaActive(false)
  }

  if (mfaActive) {
    return (
      <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-lg shadow-black/[0.06]">
        <MfaQrPanel onCancel={handleMfaCancel} />
      </div>
    )
  }

  return (
    <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-lg shadow-black/[0.06]">
      <div className="mb-5 flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-xl bg-sky-600/10 text-sky-600 dark:text-sky-400">
          <ShieldCheck className="size-4.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">特区账户登录</h3>
          <p className="text-[11px] text-muted-foreground">成都大学统一身份认证（CAS）</p>
        </div>
      </div>

      <div className="space-y-3">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="学工号"
          autoComplete="username"
          disabled={submitting}
        />
        <div className="relative">
          <Input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleLogin()
            }}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground"
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-3.5 accent-sky-600"
          />
          记住密码（经系统级加密落盘，绝不经第三方服务器中转）
        </label>

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 size-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          onClick={() => void handleLogin()}
          disabled={submitting || !username || !password}
          className="w-full gap-2 bg-sky-600 hover:bg-sky-700"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          {submitting ? '正在静默认证…' : '登录教务系统'}
        </Button>

        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          登录凭据仅保存在本机沙盒，密码经加密后存储；会话 Cookie 运行于独立隔离分区，用完即弃。
        </p>
      </div>
    </div>
  )
}

/** 账户信息条（已登录态） */
function ProfileBar({
  account,
  onRefresh,
  refreshing,
  onLogout,
}: {
  account: CduAccountProfile
  onRefresh: () => void
  refreshing: boolean
  onLogout: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-card px-5 py-4 shadow-sm">
      <span className="flex size-10 items-center justify-center rounded-full bg-sky-600/10 text-sm font-semibold text-sky-600 dark:text-sky-400">
        {account.studentName.slice(0, 1) || <School className="size-4" />}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{account.studentName || '未命名用户'}</span>
          <StatusBadge status={account.status} />
        </div>
        <span className="text-xs text-muted-foreground">{account.studentId}</span>
      </div>
      {account.semester && (
        <span className="rounded-full bg-sky-600/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          {account.semester} 学期
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} className="gap-1.5 text-muted-foreground">
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          刷新
        </Button>
        <Button variant="ghost" size="sm" onClick={onLogout} className="gap-1.5 text-muted-foreground hover:text-red-500">
          <LogOut className="size-3.5" />
          退出登录
        </Button>
      </div>
    </div>
  )
}

/** 板块容器：图标 + 标题 + 内容卡片（教务看板与 ISP 板块共用） */
export function SectionCard({
  icon,
  title,
  extra,
  children,
}: {
  icon: React.ReactNode
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-sky-600/10 text-sky-600 dark:text-sky-400">
          {icon}
        </span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {extra && <div className="ml-auto text-xs text-muted-foreground">{extra}</div>}
      </div>
      {children}
    </section>
  )
}

/** 空态提示（教务看板与 ISP 板块共用） */
export function EmptyHint({ text }: { text: string }): React.ReactElement {
  return <p className="py-4 text-center text-xs text-muted-foreground/70">{text}</p>
}

type TimetableCourse = CduOverviewData['timetable'][number]
type TimetableBlock = { course: TimetableCourse; day: number; start: number; end: number; lane: number }

/** 教务接口每节返回一条记录；相邻的同一门课合并为一张跨节次课程卡。 */
function buildTimetableBlocks(courses: TimetableCourse[]): TimetableBlock[] {
  const groups = new Map<string, { course: TimetableCourse; periods: number[] }>()
  for (const course of courses) {
    if (!Number.isInteger(course.weekday) || course.weekday < 1 || course.weekday > 7 ||
        !Number.isInteger(course.period) || (course.period ?? 0) < 1 || (course.period ?? 0) > 20) continue
    const key = JSON.stringify([
      course.weekday, course.courseCode, course.courseName, course.teacher,
      course.classroom, course.weeks, course.teachingClass,
    ])
    const group = groups.get(key) ?? { course, periods: [] }
    group.periods.push(course.period!)
    groups.set(key, group)
  }

  const blocks: TimetableBlock[] = []
  for (const { course, periods } of groups.values()) {
    const ordered = [...new Set(periods)].sort((a, b) => a - b)
    const first = ordered[0]
    if (first === undefined) continue
    let start = first
    let end = first
    for (const period of ordered.slice(1)) {
      if (period === end + 1) {
        end = period
      } else {
        blocks.push({ course, day: course.weekday, start, end, lane: 0 })
        start = end = period
      }
    }
    blocks.push({ course, day: course.weekday, start, end, lane: 0 })
  }

  // 不同周次的课程可能占同一节；并列排布，避免卡片互相遮挡。
  for (let day = 1; day <= 7; day++) {
    const laneEnds: number[] = []
    for (const block of blocks.filter((item) => item.day === day).sort((a, b) => a.start - b.start || a.end - b.end)) {
      const freeLane = laneEnds.findIndex((end) => end < block.start)
      block.lane = freeLane === -1 ? laneEnds.length : freeLane
      laneEnds[block.lane] = block.end
    }
  }
  return blocks
}

const COURSE_TONES = [
  'bg-sky-500/10 text-sky-900 dark:text-sky-100 border-sky-500/30',
  'bg-violet-500/10 text-violet-900 dark:text-violet-100 border-violet-500/30',
  'bg-teal-500/10 text-teal-900 dark:text-teal-100 border-teal-500/30',
  'bg-amber-500/10 text-amber-900 dark:text-amber-100 border-amber-500/30',
  'bg-rose-500/10 text-rose-900 dark:text-rose-100 border-rose-500/30',
] as const

function courseTone(name: string): string {
  const value = [...name].reduce((sum, char) => sum + char.codePointAt(0)!, 0)
  return COURSE_TONES[value % COURSE_TONES.length]!
}

/** 按星期和节次排列的周课表；默认定位校历本周（getXlzc 官方周次），支持周间切换。 */
function TimetableSection({ overview }: { overview: CduOverviewData }): React.ReactElement {
  const [selectedWeek, setSelectedWeek] = useAtom(cduTimetableWeekAtom)
  const currentWeek = overview.currentWeek ?? null
  // 周选择器范围：数据周次 ∪ 校历本周 ∪ 常规 20 周，覆盖无课周浏览
  const maxWeek = Math.max(20, currentWeek ?? 0, ...overview.timetable.flatMap((course) => course.weekNums))
  const allWeeks = Array.from({ length: Math.min(30, maxWeek) }, (_, index) => index + 1)
  // 默认显示本周；用户手动切换后以手动选择为准
  const activeWeek = selectedWeek ?? currentWeek ?? null
  const isCurrentWeek = activeWeek !== null && activeWeek === currentWeek
  // 校历日期：选中周的周一~周日公历日期（横轴标注月/日的依据）
  const weekDates = activeWeek !== null ? overview.calendar?.find((item) => item.week === activeWeek)?.dates : undefined
  // 今天（本地时区 ISO 日期），用于"今天"角标精确高亮
  const now = new Date()
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const isoToShort = (iso: string | null | undefined): string | null => {
    if (!iso) return null
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    return matched ? `${matched[2]}/${matched[3]}` : null
  }
  const visibleCourses = overview.timetable.filter((course) =>
    activeWeek === null || course.weekNums.length === 0 || course.weekNums.includes(activeWeek),
  )
  const blocks = buildTimetableBlocks(visibleCourses)
  const unscheduled = visibleCourses.filter((course) =>
    !Number.isInteger(course.weekday) || course.weekday < 1 || course.weekday > 7 ||
    !Number.isInteger(course.period) || (course.period ?? 0) < 1 || (course.period ?? 0) > 20,
  )
  const maxCoursePeriod = blocks.reduce((max, block) => Math.max(max, block.end), 0)
  // 行数只跟随实际排课节次（不被动辄 12 节的作息表撑高），尽量一屏看全
  const periodCount = Math.min(20, Math.max(8, maxCoursePeriod))
  const periodTimes = new Map(overview.periods.map((item) => [Number(item.period), item]))
  const blocksByDay = Array.from({ length: 7 }, (_, index) => blocks.filter((block) => block.day === index + 1))
  const dayWidths = blocksByDay.map((dayBlocks) => Math.max(144, 120 * Math.max(1, ...dayBlocks.map((block) => block.lane + 1))))
  const tableColumns = `72px ${dayWidths.map((width) => `minmax(${width}px, 1fr)`).join(' ')}`
  const tableMinWidth = 72 + dayWidths.reduce((sum, width) => sum + width, 0)
  // 选中周的日期范围（标题栏副文案）
  const weekRangeText = weekDates
    ? (() => {
        const first = isoToShort(weekDates.slice(1).find(Boolean))
        const last = isoToShort([...weekDates.slice(1)].reverse().find(Boolean))
        return first && last ? `${first} - ${last}` : null
      })()
    : null
  // 快速翻页：未选周时以本周为基准起跳
  const stepWeek = (delta: number): void => {
    const base = activeWeek ?? currentWeek ?? 1
    setSelectedWeek(Math.min(maxWeek, Math.max(1, base + delta)))
  }

  return (
    <SectionCard
      icon={<CalendarDays className="size-4" />}
      title="我的课表"
      extra={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          {overview.semester && <span>{overview.semester} 学期</span>}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="上一周"
              disabled={activeWeek !== null && activeWeek <= 1}
              onClick={() => stepWeek(-1)}
              className="flex size-6 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-sky-600/10 hover:text-sky-600 disabled:opacity-40 dark:hover:text-sky-400"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <select
              aria-label="选择课表周次"
              value={activeWeek ?? ''}
              onChange={(event) => setSelectedWeek(Number(event.target.value))}
              className="rounded-lg border border-border/60 bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              {activeWeek !== null && !allWeeks.includes(activeWeek) && <option value={activeWeek}>第 {activeWeek} 周</option>}
              {allWeeks.map((week) => <option key={week} value={week}>第 {week} 周</option>)}
            </select>
            <button
              type="button"
              aria-label="下一周"
              disabled={activeWeek !== null && activeWeek >= maxWeek}
              onClick={() => stepWeek(1)}
              className="flex size-6 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-sky-600/10 hover:text-sky-600 disabled:opacity-40 dark:hover:text-sky-400"
            >
              <ChevronRight className="size-3.5" />
            </button>
            {currentWeek !== null && (
              <button
                type="button"
                onClick={() => setSelectedWeek(currentWeek)}
                className={
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ' +
                  (isCurrentWeek
                    ? 'bg-sky-600 text-white'
                    : 'bg-sky-600/10 text-sky-600 hover:bg-sky-600/20 dark:text-sky-400')
                }
              >
                本周
              </button>
            )}
          </div>
        </div>
      )}
    >
      {overview.timetable.length === 0 ? (
        <EmptyHint text="本学期暂无排课数据" />
      ) : (
        <>
          {weekRangeText && (
            <div className="mb-2 text-[11px] text-muted-foreground">
              第 {activeWeek} 周<span className="mx-1.5">·</span>{weekRangeText}
              {isCurrentWeek && <span className="ml-1.5 text-sky-600 dark:text-sky-400">（本周）</span>}
            </div>
          )}
          <div className="overflow-auto rounded-xl border border-border/60 bg-background/70" style={{ maxHeight: 700 }}>
            <div style={{ minWidth: tableMinWidth }}>
              <div className="sticky top-0 z-20 grid bg-muted/95 text-center text-xs font-semibold text-foreground shadow-sm" style={{ gridTemplateColumns: tableColumns }}>
                <div className="sticky left-0 z-30 flex items-center justify-center border-r border-border/60 bg-muted p-2 text-muted-foreground">节次</div>
                {WEEKDAY_LABELS.slice(1).map((label, index) => {
                  const dayIso = weekDates?.[index + 1] ?? null
                  const dayShort = isoToShort(dayIso)
                  const isToday = dayIso === todayIso
                  return (
                    <div
                      key={label}
                      className={
                        'border-r border-border/50 px-2 py-2 last:border-r-0 ' +
                        (isToday ? 'bg-sky-600/10' : '')
                      }
                    >
                      <div className="flex items-center justify-center gap-1">
                        {label}
                        {isToday && <span className="rounded-full bg-sky-600 px-1.5 py-px text-[9px] font-medium text-white">今天</span>}
                      </div>
                      {dayShort && <div className="mt-0.5 text-[10px] font-normal tabular-nums text-muted-foreground">{dayShort}</div>}
                    </div>
                  )
                })}
              </div>
              <div className="grid" style={{ gridTemplateColumns: tableColumns }}>
                <div className="sticky left-0 z-10 grid border-r border-border/60 bg-background" style={{ gridTemplateRows: `repeat(${periodCount}, 60px)` }}>
                  {Array.from({ length: periodCount }, (_, index) => {
                    const time = periodTimes.get(index + 1)
                    return (
                      <div key={index} className="flex flex-col items-center justify-center border-b border-border/40 px-1 text-center last:border-b-0">
                        <span className="text-xs font-semibold text-foreground">{index + 1}</span>
                        {time?.start && <span className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{time.start}</span>}
                        {time?.end && <span className="text-[10px] tabular-nums text-muted-foreground">{time.end}</span>}
                      </div>
                    )
                  })}
                </div>
                {Array.from({ length: 7 }, (_, index) => {
                  const dayBlocks = blocksByDay[index] ?? []
                  const laneCount = Math.max(1, ...dayBlocks.map((block) => block.lane + 1))
                  return (
                    <div key={index} className="grid border-r border-border/50 last:border-r-0" style={{ gridTemplateRows: `repeat(${periodCount}, 60px)`, gridTemplateColumns: `repeat(${laneCount}, minmax(0, 1fr))` }}>
                      {Array.from({ length: periodCount }, (_, row) => (
                        <div key={`line-${row}`} className="border-b border-border/40 last:border-b-0" style={{ gridRow: row + 1, gridColumn: '1 / -1' }} />
                      ))}
                      {dayBlocks.map((block, blockIndex) => (
                        <div
                          key={`${block.course.id}-${block.start}-${blockIndex}`}
                          className={`z-[1] m-0.5 min-w-0 overflow-hidden rounded-lg border-l-[3px] px-1.5 py-1 shadow-sm ${courseTone(block.course.courseName)}`}
                          style={{ gridRow: `${block.start} / span ${block.end - block.start + 1}`, gridColumn: block.lane + 1 }}
                          title={[block.course.courseName, `第 ${block.start}${block.end > block.start ? `-${block.end}` : ''} 节`, block.course.teacher, block.course.classroom, block.course.weeks && `${block.course.weeks} 周`].filter(Boolean).join(' · ')}
                        >
                          <div className="line-clamp-2 text-[11px] font-semibold leading-tight">{block.course.courseName}</div>
                          <div className="mt-1 space-y-0.5 text-[10px] leading-tight opacity-75">
                            <div>{block.start === block.end ? `第 ${block.start} 节` : `第 ${block.start}-${block.end} 节`}</div>
                            {block.course.classroom && <div className="truncate">{block.course.classroom}</div>}
                            {block.course.weeks && <div className="truncate">{block.course.weeks} 周</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {unscheduled.length > 0 && (
            <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">未标注星期或节次：</span>
              {unscheduled.map((course, index) => (
                <span key={`${course.id}-${index}`} className="mr-2 inline-block">{course.courseName}{course.weekday >= 1 && course.weekday <= 7 ? `（${WEEKDAY_LABELS[course.weekday]}）` : ''}</span>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            默认显示校历第 {overview.currentWeek ?? '—'} 周（教务官方周次），可用 ‹ › 或下拉切换周次；卡片上的「N 周」为该课的起止周范围。
          </p>
        </>
      )}
    </SectionCard>
  )
}

/** 全部成绩 */
function GradesSection({ overview }: { overview: CduOverviewData }): React.ReactElement {
  return (
    <SectionCard
      icon={<ClipboardList className="size-4" />}
      title="我的成绩"
      extra={overview.gradeTotal > 0 ? `共 ${overview.gradeTotal} 门` : undefined}
    >
      {overview.grades.length === 0 ? (
        <EmptyHint text="暂无成绩数据" />
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {overview.grades.map((grade, index) => (
            <div key={`${grade.id}-${index}`} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-muted/60">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{grade.courseName}</div>
                <div className="text-[11px] text-muted-foreground">{grade.semester}</div>
              </div>
              {grade.gpaPoint && (
                <span className="text-[11px] text-muted-foreground">绩点 {grade.gpaPoint}</span>
              )}
              <span
                className={
                  'min-w-12 rounded-lg px-2 py-0.5 text-center text-xs font-semibold ' +
                  gradeScoreTone(grade.totalScore)
                }
              >
                {grade.totalScore}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

/** 按成绩数值给配色（及格绿 / 不及格红 / 等级制中性） */
function gradeScoreTone(score: string): string {
  const numeric = Number(score)
  if (Number.isFinite(numeric)) {
    return numeric < 60
      ? 'bg-red-500/10 text-red-600 dark:text-red-400'
      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  }
  return 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
}

/** 考试安排 */
function ExamsSection({ overview }: { overview: CduOverviewData }): React.ReactElement {
  return (
    <SectionCard icon={<Bell className="size-4" />} title="考试安排">
      {overview.exams.length === 0 ? (
        <EmptyHint text="暂无考试安排" />
      ) : (
        <div className="space-y-1.5">
          {overview.exams.map((exam, index) => (
            <div key={`${exam.id}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl bg-muted/60 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{exam.courseName}</span>
              {exam.time && <span className="text-[11px] text-muted-foreground">{exam.time}</span>}
              {exam.room && <span className="text-[11px] text-muted-foreground">@{exam.room}</span>}
              {exam.seat && <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400">{exam.seat} 座</span>}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

/** 教务通知 */
function NoticesSection({ overview }: { overview: CduOverviewData }): React.ReactElement {
  return (
    <SectionCard icon={<Bell className="size-4" />} title="教务通知">
      {overview.notices.length === 0 ? (
        <EmptyHint text="暂无通知" />
      ) : (
        <div className="space-y-1">
          {overview.notices.slice(0, 10).map((notice, index) => (
            <div key={`${notice.id}-${index}`} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-muted/60">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{notice.title}</span>
              {notice.releaseDate && (
                <span className="flex-shrink-0 text-[11px] text-muted-foreground">{notice.releaseDate.slice(0, 10)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

/** 未登录态的只读课表镜像：直接渲染 overview atom 里的离线快照 */
function CduTimetableOnly(): React.ReactElement | null {
  const [overview] = useAtom(cduOverviewAtom)
  if (!overview) return null
  return <TimetableSection overview={overview} />
}

/** CDU 专区主视图 */
export function CduZoneView(): React.ReactElement {
  const [account, setAccount] = useAtom(cduAccountAtom)
  const [, setSelectedWeek] = useAtom(cduTimetableWeekAtom)
  const [overview, setOverview] = useAtom(cduOverviewAtom)
  const [loading, setLoading] = useAtom(cduOverviewLoadingAtom)
  const [error, setError] = useAtom(cduOverviewErrorAtom)
  const [, setIspRefresh] = useAtom(cduIspRefreshAtom)
  // 数据源 Tab：教务系统（szjw）/ ISP 服务平台（xsswzx）
  const [zoneTab, setZoneTab] = React.useState<CduZoneTab>('jw')

  // 初始化：拉取账户快照并订阅状态推送（主进程保活心跳/静默恢复都会经此同步）
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.cduZone.getAccount().then((profile) => {
      if (!cancelled) setAccount(profile)
    }).catch(() => undefined)
    const unsubscribe = window.electronAPI.cduZone.onStatusChanged((profile) => {
      setAccount(profile)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [setAccount])

  const fetchOverview = React.useCallback(async (force = false): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.electronAPI.cduZone.fetchOverview(force)
      setOverview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [setLoading, setError, setOverview])

  // 登录成功后自动拉取教务数据
  React.useEffect(() => {
    if (account.status === 'active' && !overview) {
      void fetchOverview()
    }
  }, [account.status, overview, fetchOverview])

  const handleLogout = async (): Promise<void> => {
    await window.electronAPI.cduZone.logout().catch(() => undefined)
    // 保留 overview atom：登出不清缓存，未登录态用离线快照继续展示课表
    setSelectedWeek(null)
    setError(null)
    setAccount({ studentId: '', studentName: '', status: 'disconnected' })
  }

  const isLoggedIn = account.status === 'active' || account.status === 'expired'

  // 未登录且无内存数据时，读取本地离线快照（登出保留的镜像；零网络请求）
  React.useEffect(() => {
    if (isLoggedIn || overview) return
    let cancelled = false
    void window.electronAPI.cduZone
      .fetchOverviewOffline()
      .then((snapshot) => {
        if (!cancelled && snapshot) setOverview(snapshot)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [isLoggedIn, overview, setOverview])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-content-area">
      {/* 顶栏拖拽区 + 窗口控制按钮宿主（与 CDUT 专区同构） */}
      <div className="absolute inset-x-0 top-0 z-0 h-14 titlebar-drag-region" />
      <WindowControlsHost id="cdu-zone" priority={20} className="absolute right-2 top-[3px] z-20" />

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-4 p-6 pt-16">
          {/* 顶部品牌横幅：青蓝渐变（区分 CDUT 专区红金配色） */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-sky-700 to-cyan-600 px-6 py-5 text-white shadow-md">
            <div className="flex items-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-white/15">
                <School className="size-5.5" />
              </span>
              <div>
                <h1 className="text-lg font-bold tracking-tight">CDU 专区</h1>
                <p className="text-xs text-white/80">成都大学数智教务 · 统一身份认证接入 · 自爱 自修 自尊 自强</p>
              </div>
            </div>
          </div>

          {!isLoggedIn ? (
            /* 未登录态：有离线快照时 = 登录卡 + 只读课表镜像；无快照 = 品牌区 + 登录卡 */
            overview ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 rounded-xl bg-sky-500/10 px-4 py-3 text-xs text-sky-700 dark:text-sky-300">
                  <ShieldCheck className="size-4 flex-shrink-0" />
                  <span>
                    以下课表为上次登录时的本地缓存（{new Date(overview.fetchedAt).toLocaleString('zh-CN')} 快照），
                    登录后自动更新最新数据
                  </span>
                </div>
                <CduTimetableOnly />
                <div className="flex justify-center py-2">
                  <LoginCard />
                </div>
              </div>
            ) : (
            <div className="flex flex-col items-stretch gap-6 py-6 lg:flex-row lg:items-center lg:justify-center">
              <div className="max-w-md space-y-4">
                <h2 className="text-xl font-bold text-foreground">你的成大“赛博教务助手”</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  静默接入成都大学统一身份认证与数智教务，课表、成绩、考试安排、教务通知
                  一站直达。数据全部只读查询，凭据仅保存在本机沙盒。
                </p>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-sky-500" />
                    学号密码一键登录，后台静默完成 CAS 认证，界面零跳转
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-sky-500" />
                    课表 / 成绩 / 考试 / 通知四域聚合，每 10 分钟静默保活
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-sky-500" />
                    严格学生端只读：会话失效如实提示，绝不假装在线
                  </li>
                </ul>
              </div>
              <LoginCard />
            </div>
            )
          ) : (
            /* 已登录态：账户条 + 数据源 Tab + 数据看板 */
            <>
              <ProfileBar
                account={account}
                refreshing={loading}
                onRefresh={() => (zoneTab === 'isp' ? setIspRefresh((tick) => tick + 1) : void fetchOverview(true))}
                onLogout={() => void handleLogout()}
              />

              {/* 数据源切换：教务系统 / ISP 服务平台 */}
              <div className="flex gap-2">
                {(
                  [
                    { key: 'jw' as const, label: '教务系统', hint: '课表 · 成绩 · 考试 · 通知' },
                    { key: 'isp' as const, label: 'ISP 服务平台', hint: '素质分 · 图书 · 困难认定' },
                  ]
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setZoneTab(tab.key)}
                    className={
                      'flex-1 rounded-xl px-4 py-2.5 text-left transition-colors ' +
                      (zoneTab === tab.key
                        ? 'bg-sky-600 text-white shadow-sm'
                        : 'bg-card text-muted-foreground shadow-sm hover:text-foreground')
                    }
                  >
                    <div className="text-[13px] font-semibold">{tab.label}</div>
                    <div className={'text-[11px] ' + (zoneTab === tab.key ? 'text-white/75' : 'text-muted-foreground/70')}>
                      {tab.hint}
                    </div>
                  </button>
                ))}
              </div>

              {zoneTab === 'isp' ? (
                /* ISP 服务平台板块：素质分 / 图书借阅 / 困难认定 / ISP 通知 */
                <CduIspSections />
              ) : (
                <>
              {account.status === 'expired' && (
                <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
                  <AlertCircle className="size-4 flex-shrink-0" />
                  教务会话已过期，请退出后重新登录（不会静默伪装在线）
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="size-4 flex-shrink-0" />
                  {error}
                </div>
              )}
              {loading && !overview && (
                <div className="flex items-center justify-center gap-2 rounded-2xl bg-card py-10 text-sm text-muted-foreground shadow-sm">
                  <Loader2 className="size-4 animate-spin" />
                  正在拉取教务数据…
                </div>
              )}
              {overview && (
                <>
                  {overview.partialErrors.length > 0 && (
                    <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-[11px] text-amber-700 dark:text-amber-400">
                      部分数据加载失败：{overview.partialErrors.join('；')}
                    </div>
                  )}
                  <TimetableSection overview={overview} />
                  <div className="grid gap-4 lg:grid-cols-2">
                    <GradesSection overview={overview} />
                    <div className="space-y-4">
                      <ExamsSection overview={overview} />
                      <NoticesSection overview={overview} />
                    </div>
                  </div>
                  <p className="pb-2 text-center text-[11px] text-muted-foreground/60">
                    数据更新于 {new Date(overview.fetchedAt).toLocaleTimeString('zh-CN')} · 仅本机只读查询，不向任何第三方服务器中转
                  </p>
                </>
              )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
