/**
 * CDU 专区（成都大学）特区账户与教务数据类型定义
 *
 * 说明：本模块仅描述「成都大学特区账户」的本地状态、IPC 契约与教务只读查询结果。
 * 认证链路为纯 HTTP 驱动成都大学统一身份认证（id.cdu.edu.cn，CAS 协议），
 * 会话 Cookie 物理隔离于 persist:cdu-zone 分区；密码仅加密保存（见 token-crypto.ts）。
 *
 * 安全边界（与 CDUT 专区一致）：
 *   - 仅开放学生端只读查询（课表 / 成绩 / 考试 / 通知）；
 *   - 选课报名等写操作一律不在本客户端实现，规避内部敏感接口风险。
 */

export type CduAccountStatus = 'disconnected' | 'connecting' | 'active' | 'expired'

/**
 * MFA 二次验证状态机（2026-10-12 起学校强制启用）：
 * 密码正确后 CAS 返回 200 二次认证页，需企业微信扫码完成第二因子。
 * 状态流转：idle →(密码验证通过)→ awaiting-qr →(拿到二维码)→ polling →(手机确认)→ 完成
 * idle ←─(码过期/取消/超时)─┘
 */
export type CduMfaPhase = 'idle' | 'awaiting-qr' | 'polling' | 'completed'

/** MFA 二次验证的展示数据（渲染进程据此绘制二维码面板） */
export interface CduMfaQrPayload {
  /** 阶段：awaiting-qr=二维码已生成待扫；polling=已扫/等待手机确认 */
  phase: CduMfaPhase
  /** 二维码图片（PNG dataURL，来自 CAS qrgen 接口原样转发，客户端不解码内容） */
  qrImage?: string
  /** 引导文案（随阶段变化） */
  hint?: string
}

export interface CduAccountProfile {
  studentId: string
  studentName: string
  /** 教务角色标识（xs = 学生） */
  role?: string
  /** 当前学年学期（如 2026-2027-1） */
  semester?: string
  status: CduAccountStatus
  rememberPassword?: boolean
  lastLoginAt?: number
  lastActiveAt?: number
}

export interface CduLoginInput {
  username: string
  password: string
  rememberPassword?: boolean
}

export interface CduLoginResult {
  success: boolean
  error?: string
  profile?: CduAccountProfile
  /**
   * 密码正确但需要二次验证（企业微信扫码）时为 true：
   * 登录流程未结束，渲染进程应展示二维码面板并继续调用 MFA 通道。
   */
  mfaRequired?: boolean
}

/**
 * 本地已保存的 CDU 特区账户摘要，供登录卡「一键填充」。
 * 密码仅在用户勾选「记住密码」时返回解密后的明文。
 */
export interface CduSavedAccountSummary {
  hasSaved: boolean
  studentId?: string
  studentName?: string
  rememberPassword?: boolean
  savedPassword?: string
}

/** 单条课程安排（来自数智教务个人周课表 queryKbForGrdb） */
export interface CduCourseItem {
  id: string
  courseName: string
  courseCode?: string
  teacher?: string
  classroom?: string
  /** 周次原文（如 "1-2,5-6,9-11"） */
  weeks?: string
  /** 周次展开数组（如 [1,2,5,6,9,10,11]） */
  weekNums: number[]
  /** 星期（1-7） */
  weekday: number
  /** 上课节次（教务课表 xjc，每条原始记录对应一个节次） */
  period?: number
  campus?: string
  /** 校区 id（节次时间表查询依赖） */
  campusId?: string
  credits?: string
  courseCategory?: string
  examType?: string
  teachingClass?: string
  classSize?: string
}

/** 单条成绩记录（来自 xsdQueryXscjList，jqGrid 协议） */
export interface CduGradeItem {
  id: string
  semester: string
  courseName: string
  courseCode?: string
  /** 综合成绩（如 "良好" / "60"） */
  totalScore: string
  /** 学分 */
  credit?: string
  /** 绩点 */
  gpaPoint?: string
  /** 获得学分 */
  earnedCredit?: string
  courseCategory?: string
  examType?: string
}

/** 单条考试安排（来自 kwglXsdKscx/ajaxXsksList） */
export interface CduExamItem {
  id: string
  courseName: string
  /** 考试时间（如 "2026-05-17 08:40~10:10"） */
  time?: string
  room?: string
  seat?: string
  examType?: string
  examForm?: string
}

/** 单条教务通知（来自 showHomeView/getNoticeSysjlist） */
export interface CduNoticeItem {
  id: string
  title: string
  releaseDate?: string
}

/** 单个节次的上下课时间（来自 getZclistByXnxq 节次时间设置） */
export interface CduPeriodItem {
  /** 节次序号（如 "1"） */
  period: string
  start?: string
  end?: string
  /** 时段（sw=上午 / xw=下午 / ws=晚上） */
  section?: string
}

/** 校历周次（xlgl/getData）：一周 7 天的公历日期，供课表横轴标注月/日 */
export interface CduCalendarWeek {
  /** 校历周次（1 起；0 为开学前过渡周） */
  week: number
  /** 星期 1-7 → ISO 日期（yyyy-MM-dd）；下标 0 恒为 null，缺失日为 null */
  dates: (string | null)[]
}

/** 专区一站式聚合数据（一次 IPC 拉取全部只读业务域） */
export interface CduOverviewData {
  fetchedAt: number
  semester: string
  timetable: CduCourseItem[]
  grades: CduGradeItem[]
  /** 成绩总条数（跨页聚合后） */
  gradeTotal: number
  exams: CduExamItem[]
  notices: CduNoticeItem[]
  periods: CduPeriodItem[]
  /** 校历当前周次（getXlzc 官方值，用于课表默认定位本周） */
  currentWeek?: number
  /** 校历周次日期表（课表横轴标注月/日的依据） */
  calendar?: CduCalendarWeek[]
  /** 部分业务域失败时的非致命错误（不阻断整体展示） */
  partialErrors: string[]
}

export const CDU_ZONE_IPC_CHANNELS = {
  GET_ACCOUNT: 'cdu-zone:get-account',
  /** 查询本地已保存的特区账户元数据（供登录卡一键填充） */
  GET_SAVED_ACCOUNT: 'cdu-zone:get-saved-account',
  LOGIN: 'cdu-zone:login',
  LOGOUT: 'cdu-zone:logout',
  /** 拉取教务只读数据聚合（课表/成绩/考试/通知） */
  FETCH_OVERVIEW: 'cdu-zone:fetch-overview',
  /** 读取本地离线快照（未登录态展示课表用；纯读缓存文件，零网络请求） */
  FETCH_OVERVIEW_OFFLINE: 'cdu-zone:fetch-overview-offline',
  /** 拉取 ISP 学生综合服务平台数据聚合（通知/素质分/图书/困难认定） */
  FETCH_ISP: 'cdu-zone:fetch-isp',
  /** MFA：取当前二维码快照（渲染进程打开面板/刷新时拉取） */
  MFA_QR_SNAPSHOT: 'cdu-zone:mfa-qr-snapshot',
  /** MFA：主进程推送二维码阶段/图片更新（长轮询循环期间） */
  MFA_QR_UPDATED: 'cdu-zone:mfa-qr-updated',
  /** MFA：取消扫码登录（回退到 disconnected，终止主进程轮询） */
  MFA_CANCEL: 'cdu-zone:mfa-cancel',
  /** 主进程推送账户状态变化（保活心跳过期等） */
  STATUS_CHANGED: 'cdu-zone:status-changed',
} as const

// ===== ISP 学生综合服务平台（xsswzx.cdu.edu.cn，服务端渲染 ASP）=====

/** ISP 首页通知 */
export interface CduIspNotice {
  title: string
  publishDate?: string
  source?: string
  read?: boolean
}

/** 素质分单条加分/减分明细 */
export interface CduIspScoreItem {
  name: string
  score: string
}

/** 单月素质分（含个人申请明细） */
export interface CduIspScoreMonth {
  /** 月份数字（1-12） */
  month: number
  /** 当月总分（如 "29.98"，未生成为空） */
  score?: string
  /** 个人申请分 */
  appliedScore?: string
  /** 部门加减分 */
  deptScore?: string
  /** 明细项（解析自页面隐藏字段） */
  items: CduIspScoreItem[]
}

/** 素质分汇总（my_score.asp） */
export interface CduIspScoreData {
  /** 页面标记的当前月份 */
  currentMonth?: number
  /** 达标状态（如"已达标"） */
  status?: string
  months: CduIspScoreMonth[]
}

/** 个人图书借阅记录（stu_tsjy.asp） */
export interface CduIspBook {
  title: string
  /** 馆藏位置（如"社科阅览区 中文图书"） */
  location?: string
  borrowDate?: string
  dueDate?: string
  /** 页面标注的剩余天数（如"还剩79日"） */
  remainingDays?: string
}

/** 单学年家庭经济困难认定记录（pc_family.asp） */
export interface CduIspFamilyAssessment {
  /** 认定学年（如 2026-2027学年） */
  year: string
  applyTime?: string
  /** 认定结果（如"已确认申请 - 特别困难"） */
  result?: string
}

/** 家庭经济困难认定汇总 */
export interface CduIspFamilyData {
  /** 申报任务状态（家庭情况登记表 / 困难认定申请） */
  tasks: { year: string; name: string; status: string }[]
  /** 当前申请时间窗口（如"2026/9/1 6:59:59至2026/9/11 23:59:59"） */
  window?: string
  assessments: CduIspFamilyAssessment[]
}

/** ISP 一站式聚合数据 */
export interface CduIspData {
  fetchedAt: number
  /** 是否成功取得 44 位页面 token（菜单自动发现） */
  tokenFound: boolean
  notices: CduIspNotice[]
  score: CduIspScoreData | null
  books: CduIspBook[]
  family: CduIspFamilyData | null
  /** 部分页面解析失败时的非致命错误 */
  partialErrors: string[]
}
