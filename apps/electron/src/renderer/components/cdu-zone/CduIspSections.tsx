/**
 * CduIspSections — CDU 专区「ISP 服务平台」组件
 *
 * 数据来自主进程 cdu-isp-client（进站换票 → webindex 抠 token → 四页解析）：
 *   - 素质分（my_score.asp）：当前月达标状态 + 逐月得分 + 明细项（解析自页面隐藏字段）
 *   - 图书借阅（stu_tsjy.asp）：个人在借/历史书目，含到期日与剩余天数
 *   - 困难认定（pc_family.asp）：申报任务状态 + 申请窗口 + 逐学年认定结果
 *   - ISP 通知（main.asp）：首页通知列表与已读状态
 * 全部为只读解析，不构造任何 ISP 写操作。
 */

import * as React from 'react'
import { BookOpen, ClipboardCheck, Bell, Loader2, RefreshCw, AlertCircle, Wallet, ChevronRight } from 'lucide-react'
import { useAtom } from 'jotai'
import type { CduIspData } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { EmptyHint, SectionCard } from './CduZoneView'
import { cduIspDataAtom, cduIspErrorAtom, cduIspLoadingAtom } from '@/atoms/cdu-atoms'

/**
 * ISP 数据获取：整个专区只调用一次，供各展示组件共享。
 * enabled=false（未登录）时不发起请求；登录后自动拉取，失败不自动重试。
 */
export function useCduIspData(enabled: boolean): {
  data: CduIspData | null
  loading: boolean
  error: string | null
  refresh: (force?: boolean) => Promise<void>
} {
  const [data, setData] = useAtom(cduIspDataAtom)
  const [loading, setLoading] = useAtom(cduIspLoadingAtom)
  const [error, setError] = useAtom(cduIspErrorAtom)

  const load = React.useCallback(
    async (force = false): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        setData(await window.electronAPI.cduZone.fetchIsp(force))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [setData, setLoading, setError],
  )

  React.useEffect(() => {
    if (enabled && !data) void load()
  }, [enabled, data, load])

  return { data, loading, error, refresh: load }
}

/** 素质分组件 */
export function IspScoreSection({ data }: { data: CduIspData['score'] }): React.ReactElement {
  if (!data) {
    return (
      <SectionCard icon={<ClipboardCheck className="size-4" />} title="素质分">
        <EmptyHint text="暂无素质分数据" />
      </SectionCard>
    )
  }

  const withDetail = [...data.months].filter((m) => m.items.length > 0 || (m.score && m.score !== '暂未生成'))
  const current = data.months.find((m) => m.month === data.currentMonth)

  return (
    <SectionCard
      icon={<ClipboardCheck className="size-4" />}
      title="素质分"
      extra={
        data.currentMonth != null ? (
          <span>
            {data.currentMonth}月
            {data.status && <span className="ml-1.5 font-medium text-emerald-600 dark:text-emerald-400">{data.status}</span>}
          </span>
        ) : undefined
      }
    >
      {withDetail.length === 0 ? (
        <EmptyHint text="暂无素质分数据" />
      ) : (
        <div className="space-y-2.5">
          {withDetail.map((month) => (
            <div key={month.month} className="rounded-xl bg-muted/60 px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-foreground">{month.month}月</span>
                {month.score && (
                  <span className="text-sm font-bold text-sky-600 dark:text-sky-400">{month.score}</span>
                )}
                {month.deptScore && month.deptScore !== '0' && (
                  <span className="text-[11px] text-muted-foreground">部门加减 {month.deptScore}</span>
                )}
                {month.appliedScore && (
                  <span className="ml-auto text-[11px] text-muted-foreground">申请分 {month.appliedScore}</span>
                )}
              </div>
              {month.items.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {month.items.map((item, index) => (
                    <span
                      key={`${item.name}-${index}`}
                      className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300"
                    >
                      {item.name}
                      {item.score && <b className="ml-0.5">+{item.score}</b>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {current && current.score === undefined && (
            <p className="text-[11px] text-muted-foreground/70">当月分值尚未生成，生成后此处自动更新</p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

/** 图书借阅组件 */
export function IspBooksSection({
  books,
  onSelectBook,
}: {
  books: CduIspData['books']
  onSelectBook?: (book: CduIspData['books'][number]) => void
}): React.ReactElement {
  return (
    <SectionCard icon={<BookOpen className="size-4" />} title="图书借阅" extra={`${books.length} 册`}>
      {books.length === 0 ? (
        <EmptyHint text="暂无借阅记录" />
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
          {books.map((book, index) => (
            <div
              key={`${book.title}-${index}`}
              className="cursor-pointer rounded-xl px-2 py-1.5 hover:bg-muted/60"
              onClick={() => onSelectBook?.(book)}
              role={onSelectBook ? 'button' : undefined}
              tabIndex={onSelectBook ? 0 : undefined}
              onKeyDown={(event) => {
                if (!onSelectBook) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectBook(book)
                }
              }}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{book.title}</span>
                {book.remainingDays && (
                  <span
                    className={
                      'flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ' +
                      (Number(/(\d+)/.exec(book.remainingDays)?.[1] ?? '99') < 15
                        ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
                    }
                  >
                    {book.remainingDays}
                  </span>
                )}
                {onSelectBook && <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground/40" />}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                {book.location && <span>{book.location}</span>}
                {book.borrowDate && <span>借 {book.borrowDate}</span>}
                {book.dueDate && <span>到期 {book.dueDate}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

/** 困难认定组件 */
export function IspFamilySection({ data }: { data: CduIspData['family'] }): React.ReactElement {
  if (!data) {
    return (
      <SectionCard icon={<Wallet className="size-4" />} title="家庭经济困难认定">
        <EmptyHint text="暂无认定数据" />
      </SectionCard>
    )
  }

  return (
    <SectionCard icon={<Wallet className="size-4" />} title="家庭经济困难认定" extra={data.window ? `窗口 ${data.window.slice(0, 22)}…` : undefined}>
      <div className="space-y-2">
        {data.tasks.map((task, index) => (
          <div key={`${task.year}-${task.name}-${index}`} className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-1.5">
            <span className="text-xs text-foreground">
              {task.year} · {task.name}
            </span>
            <span
              className={
                'ml-auto rounded-full px-2 py-0.5 text-[10px] ' +
                (task.status.includes('已填报')
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400')
              }
            >
              {task.status}
            </span>
          </div>
        ))}
        {data.assessments.map((item, index) => (
          <div key={`${item.year}-${index}`} className="rounded-xl px-3 py-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-foreground">{item.year}</span>
              {item.result && (
                <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                  {item.result}
                </span>
              )}
              {item.applyTime && <span className="ml-auto text-[10px] text-muted-foreground">申请 {item.applyTime.slice(0, 10)}</span>}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

/** ISP 通知组件 */
export function IspNoticesSection({
  notices,
  onSelectNotice,
}: {
  notices: CduIspData['notices']
  onSelectNotice?: (notice: CduIspData['notices'][number]) => void
}): React.ReactElement {
  return (
    <SectionCard icon={<Bell className="size-4" />} title="ISP 通知" extra={notices.length > 0 ? `${notices.length} 条` : undefined}>
      {notices.length === 0 ? (
        <EmptyHint text="暂无通知" />
      ) : (
        <div className="space-y-1">
          {notices.map((notice, index) => (
            <div
              key={`${notice.title}-${index}`}
              className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-muted/60"
              onClick={() => onSelectNotice?.(notice)}
              role={onSelectNotice ? 'button' : undefined}
              tabIndex={onSelectNotice ? 0 : undefined}
              onKeyDown={(event) => {
                if (!onSelectNotice) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectNotice(notice)
                }
              }}
            >
              <span
                className={
                  'size-1.5 flex-shrink-0 rounded-full ' + (notice.read ? 'bg-muted-foreground/30' : 'bg-sky-500')
                }
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{notice.title}</span>
              {notice.source && <span className="hidden flex-shrink-0 text-[10px] text-muted-foreground sm:inline">{notice.source}</span>}
              {notice.publishDate && <span className="flex-shrink-0 text-[11px] text-muted-foreground">{notice.publishDate}</span>}
              {onSelectNotice && <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground/40" />}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

/** ISP 拉取状态条（由专区在服务分组顶部复用） */
export function CduIspStatus({
  loading,
  error,
  data,
  onRetry,
}: {
  loading: boolean
  error: string | null
  data: CduIspData | null
  onRetry: () => void
}): React.ReactElement | null {
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl bg-card py-8 text-sm text-muted-foreground shadow-sm">
        <Loader2 className="size-4 animate-spin" />
        正在进入 ISP 服务平台并解析页面…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-xs text-red-600 dark:text-red-400">
        <AlertCircle className="size-4 flex-shrink-0" />
        {error}
        <Button variant="ghost" size="sm" onClick={onRetry} className="ml-auto gap-1">
          <RefreshCw className="size-3" />
          重试
        </Button>
      </div>
    )
  }
  if (data?.partialErrors.length) {
    return (
      <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-[11px] text-amber-700 dark:text-amber-400">
        部分数据解析失败：{data.partialErrors.join('；')}
      </div>
    )
  }
  return null
}
