/**
 * CduDetailDialog — 专区条目的详情卡
 *
 * 只展示当前已经取到的字段；需要学校页面才能看到的内容通过 action 按钮
 * 在已登录的 CDU 会话窗口打开，不在渲染层拼接口。
 */

import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@profer/ui/primitives/dialog'

export interface CduDetailField {
  label: string
  value?: React.ReactNode
}

export function CduDetailDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  fields,
  actionLabel,
  onAction,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  subtitle?: string
  fields: CduDetailField[]
  actionLabel?: string
  onAction?: () => void
}): React.ReactElement {
  const visible = fields.filter((field) => field.value !== undefined && field.value !== null && field.value !== '')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8 text-sm leading-relaxed">{title}</DialogTitle>
          {subtitle && <DialogDescription className="text-xs">{subtitle}</DialogDescription>}
        </DialogHeader>

        {visible.length > 0 ? (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 rounded-xl bg-muted/40 p-3 text-xs">
            {visible.map((field) => (
              <React.Fragment key={field.label}>
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">暂无更多信息</p>
        )}

        {actionLabel && onAction && (
          <DialogFooter>
            <Button variant="outline" onClick={onAction} className="gap-1.5">
              <ExternalLink className="size-3.5" />
              {actionLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
