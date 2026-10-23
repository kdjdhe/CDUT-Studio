/**
 * CduVpnCard — CDU 专区「校园网 VPN」导入与连接卡片
 *
 * 为什么需要它：学校 2026-10 把 VPN 从深信服客户端换成 WireGuard，
 * 每台设备需要到门户申请一份 .conf。校内网络下这些功能本来就通，
 * 校外只有「个人中心」可用，其余业务系统会返回伪装成「页面正在修复中」的拦截页。
 *
 * 交互约束（来自学校规定「同一份配置同时只能一台设备在线」）：
 *   - 连接是显式动作，不在启动时自动连接；
 *   - 卡片上常驻「断开」按钮，并在连通性异常时提示可能是其它设备在线；
 *   - 网络环境判定在**登录之后**才发起，因为未登录时业务端点只会返回 302 跳 CAS。
 */

import * as React from 'react'
import {
  AlertCircle,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unplug,
  Zap,
} from 'lucide-react'
import type { CduNetState, CduVpnState } from '@profer/shared'

interface CduVpnCardProps {
  /** 登录后才发起网络环境探测（未登录时业务端点只会 302 跳 CAS） */
  isLoggedIn: boolean
}

const STATUS_META: Record<CduVpnState['status'], { label: string; dot: string; text: string }> = {
  'not-configured': {
    label: '未导入配置',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
  },
  stopped: { label: '已就绪（未连接）', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  starting: { label: '正在建立隧道', dot: 'bg-sky-500 animate-pulse', text: 'text-sky-600 dark:text-sky-400' },
  connected: { label: '隧道已连接', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: '隧道异常', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
}

const NET_META: Record<CduNetState, { label: string; className: string }> = {
  ok: { label: '校园网可达', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  blocked: { label: '校外受限，需连接 VPN', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  'need-login': { label: '未登录', className: 'bg-muted text-muted-foreground' },
  unreachable: { label: '校园网不可达', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  unknown: { label: '未检测', className: 'bg-muted text-muted-foreground' },
}

function cnBadge(extra: string): string {
  return `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${extra}`
}

export function CduVpnCard({ isLoggedIn }: CduVpnCardProps): React.ReactElement {
  const [state, setState] = React.useState<CduVpnState | null>(null)
  const [busy, setBusy] = React.useState<'import' | 'connect' | 'disconnect' | 'probe' | 'remove' | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const probedRef = React.useRef(false)

  React.useEffect(() => {
    let alive = true
    void window.electronAPI.cduVpn.getState().then((next) => {
      if (alive) setState(next)
    })
    const unsubscribe = window.electronAPI.cduVpn.onStatusChanged((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 登录后探测一次；登出后重置，下次登录重新判定
  React.useEffect(() => {
    if (!isLoggedIn) {
      probedRef.current = false
      return
    }
    if (probedRef.current) return
    probedRef.current = true
    void window.electronAPI.cduVpn.probeNetwork().then(setState)
  }, [isLoggedIn])

  const run = async (
    action: 'import' | 'connect' | 'disconnect' | 'probe' | 'remove',
    task: () => Promise<CduVpnState | void>,
  ): Promise<void> => {
    setBusy(action)
    setNotice(null)
    try {
      await task()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const handleImport = (): void => {
    void run('import', async () => {
      const result = await window.electronAPI.cduVpn.importConfig()
      setState(result.state)
      if (!result.success) {
        setNotice(result.error ?? '导入失败')
        return
      }
      setNotice('配置已导入。建议先连接隧道，再点击「检测网络」。')
    })
  }

  const handleConnect = (): void => {
    void run('connect', async () => {
      const next = await window.electronAPI.cduVpn.connect()
      setState(next)
      if (next.status === 'connected') void window.electronAPI.cduVpn.probeNetwork().then(setState)
      else if (next.error) setNotice(next.error)
    })
  }

  const handleDisconnect = (): void => {
    void run('disconnect', async () => setState(await window.electronAPI.cduVpn.disconnect()))
  }

  const handleProbe = (): void => {
    void run('probe', async () => setState(await window.electronAPI.cduVpn.probeNetwork()))
  }

  const handleRemove = (): void => {
    if (!window.confirm('删除本地保存的校园网 VPN 配置？删除后需要重新导入学校的 .conf 文件。')) return
    void run('remove', async () => setState(await window.electronAPI.cduVpn.removeConfig()))
  }

  const statusMeta = STATUS_META[state?.status ?? 'not-configured']
  const netMeta = NET_META[state?.netState ?? 'unknown']
  const config = state?.config ?? null
  const errorText = notice ?? state?.error ?? null

  return (
    <section className="rounded-xl border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sky-600/10 text-sky-600 dark:text-sky-400">
            <ShieldCheck size={16} />
          </span>
          <div>
            <h3 className="text-xs font-semibold text-foreground">校园网 VPN</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              WireGuard 分流隧道 · 仅 CDU 分区经此出网
            </p>
          </div>
        </div>
        <span className={cnBadge('bg-muted/70 text-muted-foreground')}>
          <span className={`size-1.5 rounded-full ${statusMeta.dot}`} />
          <span className={statusMeta.text}>{statusMeta.label}</span>
        </span>
      </header>

      {config ? (
        <dl className="mt-3 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5">
            <dt className="text-muted-foreground">对端</dt>
            <dd className="truncate font-mono text-foreground">{config.endpoint}</dd>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5">
            <dt className="text-muted-foreground">隧道地址</dt>
            <dd className="truncate font-mono text-foreground">{config.address}</dd>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 sm:col-span-2">
            <dt className="text-muted-foreground">本机公钥</dt>
            <dd className="truncate font-mono text-foreground" title={config.publicKey}>
              {config.publicKey.slice(0, 24)}…
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-3 rounded-lg bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          尚未导入配置。请到学校 VPN 门户申请一份 WireGuard 配置（.conf 或包含 .conf 的 .zip），
          在校外网络下需要它才能访问数智教务、ISP 等业务系统。
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleImport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          {busy === 'import' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          导入配置
        </button>

        {config ? (
          state?.status === 'connected' ? (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
            >
              {busy === 'disconnect' ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />}
              断开
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={busy !== null || state?.status === 'starting'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
            >
              {busy === 'connect' || state?.status === 'starting' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Zap size={13} />
              )}
              连接
            </button>
          )
        ) : null}

        <button
          type="button"
          onClick={handleProbe}
          disabled={busy !== null || !isLoggedIn}
          title={isLoggedIn ? '探测当前是否具备校园网访问权限' : '登录后才能判定（未登录时业务端点只会跳登录页）'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          {busy === 'probe' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          检测网络
        </button>

        {config ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-rose-600 disabled:opacity-50"
          >
            {busy === 'remove' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            移除
          </button>
        ) : null}

        <span className={cnBadge(`ml-auto ${netMeta.className}`)}>{netMeta.label}</span>
      </div>

      {errorText ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
          <span>{errorText}</span>
        </p>
      ) : null}

      {state?.status === 'connected' && state.netState === 'unreachable' ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <ShieldAlert size={13} className="mt-0.5 flex-shrink-0" />
          <span>
            隧道进程正常但校园网不通，通常是同一份配置已有其它设备在线。请先在手机或另一台电脑上断开，再点「连接」。
          </span>
        </p>
      ) : null}

      <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground/70">
        学校规定同一份配置同时只能一台设备在线；本客户端不会自动重连，退出应用即断开隧道。
        私钥经系统级加密保存在本机，仅用于建立隧道。
      </p>
    </section>
  )
}
