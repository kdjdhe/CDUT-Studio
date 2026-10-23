/**
 * CDU 专区（成都大学）状态 Atom
 *
 * 仅保存「特区账户」与教务只读数据的本地展示状态。
 * 真实认证与凭证加密全部在主进程完成，渲染进程只消费
 * window.electronAPI.cduZone 推送与查询结果，绝不接触明文密码。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { CduAccountProfile, CduOverviewData, CduIspData } from '@profer/shared'
import type { CduDashboardPrefs } from '@/components/cdu-zone/cdu-dashboard'

/** CDU 特区账户全局状态（默认未连接） */
export const cduAccountAtom = atom<CduAccountProfile>({
  studentId: '',
  studentName: '',
  status: 'disconnected',
})

/** 教务只读数据聚合（课表/成绩/考试/通知），登录成功后拉取 */
export const cduOverviewAtom = atom<CduOverviewData | null>(null)

/** 教务数据拉取中标记 */
export const cduOverviewLoadingAtom = atom<boolean>(false)

/** 教务数据拉取错误（会话失效/网络异常等，阻断展示） */
export const cduOverviewErrorAtom = atom<string | null>(null)

/** 手动选择查看的周次；null 表示展示全部周次 */
export const cduTimetableWeekAtom = atom<number | null>(null)

/** ISP 聚合数据（登录后按需拉取；隐藏全部 ISP 组件时不访问站点） */
export const cduIspDataAtom = atom<CduIspData | null>(null)

/** ISP 数据拉取中标记 */
export const cduIspLoadingAtom = atom<boolean>(false)

/** ISP 数据拉取错误（统一认证过期/解析失败等） */
export const cduIspErrorAtom = atom<string | null>(null)

/**
 * 展示偏好：按学号隔离，只保存在本机渲染进程。
 * 结构见 cdu-dashboard.tsx；缺省账户使用 __default__ 键。
 */
export const cduDashboardPrefsAtom = atomWithStorage<Record<string, CduDashboardPrefs>>(
  'cdu-dashboard-prefs',
  {},
)
