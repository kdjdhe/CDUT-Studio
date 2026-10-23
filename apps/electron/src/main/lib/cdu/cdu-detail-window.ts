/**
 * cdu-detail-window — 在 CDU 已登录会话中打开学校页面
 *
 * 通知原文、借阅明细、困难认定等详情都发生在学校自己的页面里。
 * 这里复用 persist:cdu-zone 分区打开只读窗口，共享 CAS 会话，
 * 同时把导航限制在 cdu.edu.cn，避免把已登录会话带到校外站点。
 */

import { BrowserWindow } from 'electron'
import { CDU_SESSION_PARTITION } from './cdu-auth-manager'

const detailWindows = new Set<BrowserWindow>()

/** 只允许成都大学域名（含子域名），协议只接受 http/https。 */
export function isCduUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return url.hostname === 'cdu.edu.cn' || url.hostname.endsWith('.cdu.edu.cn')
  } catch {
    return false
  }
}

export function openCduDetailWindow(url: string, title?: string): { success: boolean; error?: string } {
  if (!isCduUrl(url)) {
    return { success: false, error: '仅支持打开成都大学校内页面' }
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    title: title ?? '成都大学',
    autoHideMenuBar: true,
    webPreferences: {
      partition: CDU_SESSION_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  detailWindows.add(win)
  win.on('closed', () => {
    detailWindows.delete(win)
  })

  // 页面内 target=_blank 仍留在同一窗口；校外地址直接拒绝。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isCduUrl(target)) void win.loadURL(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (!isCduUrl(target)) event.preventDefault()
  })

  void win.loadURL(url)
  return { success: true }
}

/** 退出登录 / 重新登录时关闭所有详情窗口，避免残留已登录页面。 */
export function closeCduDetailWindows(): void {
  for (const win of [...detailWindows]) {
    if (!win.isDestroyed()) win.destroy()
  }
  detailWindows.clear()
}
