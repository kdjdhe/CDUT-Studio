import { describe, expect, test } from 'bun:test'
import {
  CDU_DEFAULT_PREFS,
  moveCduDashboardComponent,
  normalizeCduDashboardPrefs,
  reorderCduDashboardComponent,
  setCduDashboardComponentVisible,
  setCduDashboardServiceVisible,
  visibleCduDashboardComponents,
} from './cdu-dashboard'

describe('CDU 展示偏好', () => {
  test('归一化补齐缺失组件，丢弃未知项与重复项', () => {
    const prefs = normalizeCduDashboardPrefs({
      version: 1,
      order: { jw: ['jw.grades', 'jw.grades', 'unknown'], isp: [] },
      hidden: ['jw.exams', 'unknown'],
    })

    expect(prefs.order.jw[0]).toBe('jw.grades')
    expect(prefs.order.jw).toHaveLength(4)
    expect(new Set(prefs.order.jw).size).toBe(4)
    expect(prefs.order.isp).toEqual(['isp.score', 'isp.books', 'isp.family', 'isp.notices'])
    expect(prefs.hidden).toEqual(['jw.exams'])
  })

  test('组内上移/下移并拒绝越界', () => {
    const moved = moveCduDashboardComponent(CDU_DEFAULT_PREFS, 'jw', 'jw.timetable', 1)
    expect(moved.order.jw.slice(0, 2)).toEqual(['jw.grades', 'jw.timetable'])

    const atTop = moveCduDashboardComponent(CDU_DEFAULT_PREFS, 'jw', 'jw.timetable', -1)
    expect(atTop).toBe(CDU_DEFAULT_PREFS)
  })

  test('拖拽到指定下标后保持其余项顺序', () => {
    const moved = reorderCduDashboardComponent(CDU_DEFAULT_PREFS, 'jw', 'jw.timetable', 2)
    expect(moved.order.jw).toEqual(['jw.grades', 'jw.exams', 'jw.timetable', 'jw.notices'])

    const noop = reorderCduDashboardComponent(CDU_DEFAULT_PREFS, 'jw', 'jw.timetable', 99)
    expect(noop).toBe(CDU_DEFAULT_PREFS)
  })

  test('隐藏单个组件后按原顺序返回可见项', () => {
    const prefs = setCduDashboardComponentVisible(CDU_DEFAULT_PREFS, 'jw.grades', false)
    expect(prefs.hidden).toEqual(['jw.grades'])
    expect(visibleCduDashboardComponents(prefs, 'jw')).toEqual([
      'jw.timetable',
      'jw.exams',
      'jw.notices',
    ])
  })

  test('整个子服务可一键隐藏并恢复', () => {
    const hidden = setCduDashboardServiceVisible(CDU_DEFAULT_PREFS, 'isp', false)
    expect(visibleCduDashboardComponents(hidden, 'isp')).toEqual([])

    const shown = setCduDashboardServiceVisible(hidden, 'isp', true)
    expect(shown.hidden).toEqual([])
    expect(visibleCduDashboardComponents(shown, 'isp')).toHaveLength(4)
  })
})
