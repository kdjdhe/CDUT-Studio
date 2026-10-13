/**
 * CDU 专区数据缓存（教务聚合 + ISP 聚合）—— 按数据变化频率分级
 *
 * 两级缓存：内存（进程内即时命中）+ JSON 文件（跨重启复用，原子写入）。
 * 用户主动点「刷新」时带 force=true 绕过缓存；TTL 内的 Tab 切换与重启恢复零网络请求。
 *
 * 分级 TTL（2026-10-12，按数据实际变化频率）：
 *   - 课表/节次/校历：学期初定好后基本不变 → 24h；
 *   - 成绩/考试：数周~数月一变 → 1h（出成绩季靠手动刷新兜底）；
 *   - 通知/学期/周次：天级变化 → 10min（保持新鲜度）。
 *   TTL 按域独立判定：fetchOverview 逐域合并「分级缓存命中 + 过期域重爬」。
 *
 * 未登录只读镜像：退出登录不清除缓存文件，而是保留为离线快照——
 * 未登录态下界面可用快照渲染课表（低敏数据），登录成功后自动被新数据覆盖。
 * 隐私边界与「记住密码」一致：本机本人使用；密码不落盘时镜像同样可被
 * 其他本机用户读到（仅课表级低敏信息），如需彻底清除请删除缓存文件。
 */

import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getCduCachePath } from '../config-paths'
import type { CduIspData, CduOverviewData } from '@profer/shared'

/** 缓存种类：教务聚合 / ISP 聚合 */
export type CduCacheKind = 'overview' | 'isp'

/** 分级 TTL（毫秒）：课表级（学期稳定）/ 学业级（月度变化）/ 资讯级（天级变化） */
export const CDU_TTL_TIMETABLE_MS = 24 * 60 * 60 * 1000
export const CDU_TTL_ACADEMIC_MS = 60 * 60 * 1000
export const CDU_TTL_NEWS_MS = 10 * 60 * 1000

interface CduCacheEntry<T = unknown> {
  fetchedAt: number
  data: T
}

interface CduCacheFile {
  overview?: CduCacheEntry
  isp?: CduCacheEntry
}

/** 进程内存层（优先命中，避免每次读盘） */
const memoryCache = new Map<CduCacheKind, CduCacheEntry>()

/** 读取缓存：内存优先，其次磁盘；超过 maxAgeMs 视为过期返回 null */
export function getCachedCduData<T>(kind: CduCacheKind, maxAgeMs: number): T | null {
  const memoryEntry = memoryCache.get(kind)
  if (memoryEntry && Date.now() - memoryEntry.fetchedAt < maxAgeMs) {
    return memoryEntry.data as T
  }
  const file = readJsonFileSafe<CduCacheFile>(getCduCachePath())
  const entry = file?.[kind]
  if (entry?.data && typeof entry.fetchedAt === 'number' && Date.now() - entry.fetchedAt < maxAgeMs) {
    memoryCache.set(kind, entry as CduCacheEntry)
    return entry.data as T
  }
  return null
}

/**
 * 读取「分级命中」的缓存切片：返回各域按自身 TTL 判定的新鲜度。
 * fresh 域可直接复用，stale 域需要重爬后由调用方合并。
 */
export function getCduOverviewFreshness(data: CduOverviewData): {
  timetable: boolean
  academic: boolean
  news: boolean
} {
  const age = Date.now() - data.fetchedAt
  return {
    timetable: age < CDU_TTL_TIMETABLE_MS,
    academic: age < CDU_TTL_ACADEMIC_MS,
    news: age < CDU_TTL_NEWS_MS,
  }
}

/** 写入缓存：内存 + 磁盘原子落盘（不落盘不影响内存命中） */
export function setCachedCduData<T>(kind: CduCacheKind, data: T): void {
  const entry: CduCacheEntry<T> = { fetchedAt: Date.now(), data }
  memoryCache.set(kind, entry)
  const file = readJsonFileSafe<CduCacheFile>(getCduCachePath()) ?? {}
  file[kind] = entry
  try {
    writeJsonFileAtomic(getCduCachePath(), file)
  } catch {
    // 磁盘写入失败不影响内存缓存
  }
}

/**
 * 登出处理：不删除缓存文件（保留为未登录可看的离线快照），
 * 仅清掉进程内存层（强制下次登录重新走网络链路）。
 * 历史背景：此前登出会整体清空缓存；2026-10-12 按用户需求改为保留镜像，
 * 使未登录态也能查看课表等低敏离线数据。如需彻底清除，删除缓存文件即可。
 */
export function onCduLogout(): void {
  memoryCache.clear()
}

/**
 * 未登录态的离线快照读取（只读缓存文件，零网络请求、不碰内存层）。
 * 供未登录界面渲染课表等低敏数据；无快照时返回 null。
 */
export function getOfflineOverviewSnapshot(): CduOverviewData | null {
  const file = readJsonFileSafe<CduCacheFile>(getCduCachePath())
  const entry = file?.overview
  if (entry?.data && typeof entry.fetchedAt === 'number') {
    return entry.data as CduOverviewData
  }
  return null
}
