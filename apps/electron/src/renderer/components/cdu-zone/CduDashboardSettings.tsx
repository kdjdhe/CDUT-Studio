/**
 * CduDashboardSettings — CDU 专区“自定义展示”面板
 *
 * 以“统一身份认证”为根节点，展开子服务（数智教务 / ISP），
 * 再展开每个子服务的功能树；开关控制是否显示，组内可调整顺序。
 */

import * as React from 'react'
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Switch } from '@profer/ui/primitives/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@profer/ui/primitives/dialog'
import {
  CDU_DASHBOARD_COMPONENTS,
  CDU_DASHBOARD_SERVICES,
  CDU_DEFAULT_PREFS,
  moveCduDashboardComponent,
  normalizeCduDashboardPrefs,
  reorderCduDashboardComponent,
  setCduDashboardComponentVisible,
  setCduDashboardServiceVisible,
  type CduDashboardComponentId,
  type CduDashboardPrefs,
  type CduDashboardServiceId,
} from './cdu-dashboard'

interface CduDragRowRect {
  top: number
  height: number
}

interface CduDragState {
  service: CduDashboardServiceId
  id: CduDashboardComponentId
  pointerId: number
  startY: number
  deltaY: number
  startIndex: number
  targetIndex: number
  rowRects: CduDragRowRect[]
  rowHeight: number
}

export function CduDashboardSettings({
  open,
  onOpenChange,
  prefs,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefs: CduDashboardPrefs
  onChange: (next: CduDashboardPrefs) => void
}): React.ReactElement {
  const hidden = React.useMemo(() => new Set(prefs.hidden), [prefs.hidden])
  const [expanded, setExpanded] = React.useState<Record<CduDashboardServiceId, boolean>>({
    jw: true,
    isp: true,
  })
  const allExpanded = CDU_DASHBOARD_SERVICES.every((service) => expanded[service.id])

  const setServiceExpanded = (service: CduDashboardServiceId, value: boolean): void => {
    setExpanded((previous) => ({ ...previous, [service]: value }))
  }

  // ===== 拖动排序：指针拖拽 + 其他行平滑让位 =====
  const [drag, setDrag] = React.useState<CduDragState | null>(null)
  const dragRef = React.useRef<CduDragState | null>(null)
  const rafRef = React.useRef<number | null>(null)

  const clearDrag = React.useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    dragRef.current = null
    setDrag(null)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const beginDrag = React.useCallback(
    (service: CduDashboardServiceId, id: CduDashboardComponentId, event: React.PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      const list = event.currentTarget.closest('[data-cdu-sort-list]') as HTMLElement | null
      if (!list) return
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-cdu-sort-row]'))
      const rowRects = rows.map((row) => {
        const rect = row.getBoundingClientRect()
        return { top: rect.top, height: rect.height }
      })
      const startIndex = prefs.order[service].indexOf(id)
      const startRect = rowRects[startIndex]
      if (startIndex < 0 || !startRect) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus()
      // 捕获指针：拖出窗口再松手也能收到 pointerup，不会卡在拖拽态。
      event.currentTarget.setPointerCapture(event.pointerId)
      const next: CduDragState = {
        service,
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        deltaY: 0,
        startIndex,
        targetIndex: startIndex,
        rowRects,
        rowHeight: startRect.height,
      }
      dragRef.current = next
      setDrag(next)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'
    },
    [prefs.order],
  )

  // 指针移动只更新目标下标；rAF 节流保证拖拽跟手且不刷爆渲染。
  const dragPointerId = drag?.pointerId
  React.useEffect(() => {
    if (dragPointerId == null) return
    const computeTarget = (state: CduDragState, deltaY: number): number => {
      const start = state.rowRects[state.startIndex]
      if (!start) return state.startIndex
      const center = start.top + start.height / 2 + deltaY
      let target = state.startIndex
      for (let index = 0; index < state.rowRects.length; index++) {
        if (index === state.startIndex) continue
        const rect = state.rowRects[index]
        if (!rect) continue
        const middle = rect.top + rect.height / 2
        if (index < state.startIndex && center < middle) {
          target = index
          break
        }
        if (index > state.startIndex && center > middle) target = index
      }
      return target
    }

    const onMove = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) return
      const deltaY = event.clientY - state.startY
      const targetIndex = computeTarget(state, deltaY)
      if (Math.abs(deltaY - state.deltaY) < 0.5 && targetIndex === state.targetIndex) return
      dragRef.current = { ...state, deltaY, targetIndex }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          const latest = dragRef.current
          if (latest) setDrag(latest)
        })
      }
    }

    const finish = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) return
      if (state.targetIndex !== state.startIndex) {
        onChange(reorderCduDashboardComponent(prefs, state.service, state.id, state.targetIndex))
      }
      clearDrag()
    }

    const cancel = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) return
      clearDrag()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clearDrag()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dragPointerId, onChange, prefs, clearDrag])

  React.useEffect(() => () => clearDrag(), [clearDrag])

  /** 拖拽过程中其他行的让位偏移。 */
  const dragShift = (service: CduDashboardServiceId, index: number): number => {
    if (!drag || drag.service !== service) return 0
    if (index === drag.startIndex) return 0
    if (drag.targetIndex > drag.startIndex && index > drag.startIndex && index <= drag.targetIndex) {
      return -drag.rowHeight
    }
    if (drag.targetIndex < drag.startIndex && index >= drag.targetIndex && index < drag.startIndex) {
      return drag.rowHeight
    }
    return 0
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-sky-600 dark:text-sky-400" />
            自定义专区展示
          </DialogTitle>
          <DialogDescription>
            按统一身份认证的层级展开：根节点下是子服务，子服务下是功能。开关控制是否显示，拖动右侧手柄可调整组内顺序（也可用方向键）；偏好只保存在本机，并按学号隔离。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 px-3 py-2.5">
            <span className="flex size-7 items-center justify-center rounded-lg bg-sky-600/10 text-sky-600 dark:text-sky-400">
              <ShieldCheck className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-foreground">统一身份认证</h3>
                <span className="rounded-full bg-sky-600/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
                  根节点
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">CAS 登录后展开的学校子服务与功能</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-[11px]"
              onClick={() =>
                setExpanded(
                  allExpanded
                    ? { jw: false, isp: false }
                    : { jw: true, isp: true },
                )
              }
            >
              {allExpanded ? '全部收起' : '全部展开'}
            </Button>
          </div>

          {/* 根节点向下延伸的树线 */}
          <div className="relative ml-3 space-y-1 border-l border-border/70 pl-5">
            {/* 身份与账户：专区框架，常显 */}
            <div className="relative py-1">
              <span className="absolute -left-5 top-1/2 h-px w-5 bg-border/70" />
              <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
                <ShieldCheck className="size-4 flex-shrink-0 text-sky-600 dark:text-sky-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-foreground">身份与账户</div>
                  <div className="text-[10px] text-muted-foreground">学号、姓名、学期、登录状态</div>
                </div>
                <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  常显
                </span>
              </div>
            </div>

            {CDU_DASHBOARD_SERVICES.map((service) => {
              const ids = prefs.order[service.id]
              const visibleCount = ids.filter((id) => !hidden.has(id)).length
              const serviceVisible = visibleCount > 0
              const isExpanded = expanded[service.id]
              const ServiceIcon = service.icon
              return (
                <div key={service.id} className="relative py-1">
                  <span className="absolute -left-5 top-6 h-px w-5 bg-border/70" />
                  <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => setServiceExpanded(service.id, !isExpanded)}
                      className="flex size-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={isExpanded ? `收起${service.title}` : `展开${service.title}`}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-lg bg-sky-600/10 text-sky-600 dark:text-sky-400">
                      <ServiceIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="truncate text-xs font-semibold text-foreground">{service.title}</h4>
                        <span className="flex-shrink-0 rounded-full bg-sky-600/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
                          子服务
                        </span>
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {service.subtitle} · {visibleCount}/{ids.length} 个功能
                      </div>
                    </div>
                    <Switch
                      checked={serviceVisible}
                      onCheckedChange={(checked) =>
                        onChange(setCduDashboardServiceVisible(prefs, service.id, checked))
                      }
                      aria-label={`显示${service.title}`}
                    />
                  </div>

                  {isExpanded && (
                    <div data-cdu-sort-list={service.id} className="relative ml-5 mt-1 border-l border-border/60 pl-4">
                      {ids.map((id, index) => {
                        const meta = CDU_DASHBOARD_COMPONENTS[id]
                        const ItemIcon = meta.icon
                        const visible = !hidden.has(id)
                        const isDragging = Boolean(drag && drag.service === service.id && drag.id === id)
                        const dragOffset = isDragging && drag ? drag.deltaY : 0
                        const shift = dragShift(service.id, index)
                        const rowStyle: React.CSSProperties = {
                          transform: isDragging
                            ? `translateY(${dragOffset}px)`
                            : shift
                              ? `translateY(${shift}px)`
                              : undefined,
                          transition: isDragging
                            ? 'none'
                            : 'transform 180ms cubic-bezier(0.2, 0, 0, 1), background-color 180ms, box-shadow 180ms',
                          willChange: isDragging || shift ? 'transform' : undefined,
                          zIndex: isDragging ? 20 : undefined,
                        }
                        return (
                          <div
                            key={id}
                            data-cdu-sort-row={id}
                            style={rowStyle}
                            className={
                              'relative flex items-center gap-2 rounded-lg py-1.5 ' +
                              (isDragging ? 'bg-card shadow-lg ring-1 ring-sky-500/30' : '')
                            }
                          >
                            <span className="absolute -left-4 top-1/2 h-px w-4 bg-border/60" />
                            <Switch
                              checked={visible}
                              onCheckedChange={(checked) =>
                                onChange(setCduDashboardComponentVisible(prefs, id, checked))
                              }
                              aria-label={`显示${meta.title}`}
                            />
                            <span className="flex size-6 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <ItemIcon className="size-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-foreground">{meta.title}</div>
                              <div className="truncate text-[10px] text-muted-foreground">{meta.description}</div>
                            </div>
                            <button
                              type="button"
                              onPointerDown={(event) => beginDrag(service.id, id, event)}
                              onKeyDown={(event) => {
                                if (event.key === 'ArrowUp') {
                                  event.preventDefault()
                                  onChange(moveCduDashboardComponent(prefs, service.id, id, -1))
                                } else if (event.key === 'ArrowDown') {
                                  event.preventDefault()
                                  onChange(moveCduDashboardComponent(prefs, service.id, id, 1))
                                }
                              }}
                              className="flex size-6 flex-shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
                              aria-label={`拖动调整${meta.title}顺序，或用上下方向键`}
                              title="拖动排序（也可用 ↑↓ 键）"
                            >
                              <GripVertical className="size-3.5" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            当前展示统一身份认证已接入的两个子服务。后续从认证平台发现更多应用时，会作为新的子服务分支加入这棵树。
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(normalizeCduDashboardPrefs(CDU_DEFAULT_PREFS))}
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            恢复默认
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
