export type ShipmentStatus = '待装机' | '运输中' | '待放行' | '已放行' | '已拒绝'
export type DeviationStatus = '待调查' | '调查中' | '待放行复核' | '待重新复核' | '已关闭'
export type SignatureStatus = '待签' | '已签' | '已退回' | '已撤回'
export type EvidenceState = '现行' | '已废止'

export interface TemperaturePoint {
  id: string
  time: string
  value: number
}

export interface ShipmentSegment {
  id: string
  from: string
  to: string
  flight: string
  plannedStart: string
  actualStart: string
  actualEnd: string
  handler: string
  note: string
  temperature: TemperaturePoint[]
}

export interface EvidenceFile {
  id: string
  name: string
  category: '温度曲线' | '设备报告' | '包装确认' | '交接签字'
  /** 同分类证据自身的文件版本号 */
  version: number
  /** 写入该证据时运输任务的统一版本号 */
  recordVersion: number
  state: EvidenceState
  supersededByRecord?: number
  /** 放行后更正另存的原因版本 */
  correctionReason?: string
  uploadedBy: string
  uploadedAt: string
  verified: boolean
}

/** 调查结论对具体证据版本的引用，证据换版后据此判定失效 */
export interface EvidenceRef {
  evidenceId: string
  category: EvidenceFile['category']
  evidenceVersion: number
  recordVersion: number
}

export interface SignatureHistoryEntry {
  status: '已签' | '已退回' | '已撤回'
  name: string
  comment: string
  signedAt: string
  reason?: string
  recordVersion: number
}

export interface ShipmentSignature {
  role: '发货方' | '承运方' | '收货方' | '放行人员'
  name: string
  status: SignatureStatus
  signedAt: string
  comment: string
  withdrawnAt?: string
  withdrawReason?: string
  /** 历次签署/撤回意见全部保留，撤回不抹除原意见 */
  history: SignatureHistoryEntry[]
}

export interface ReviewHistoryEntry {
  disposition: '接受' | '补充处理' | '拒绝'
  reviewer: string
  reviewNote: string
  reviewedAt: string
  evidenceVersion: string
  recordVersion: number
  superseded: boolean
}

export interface Shipment {
  id: string
  product: string
  batch: string
  route: string
  containerId: string
  tempMin: number
  tempMax: number
  plannedDeparture: string
  actualArrival: string
  status: ShipmentStatus
  segments: ShipmentSegment[]
  evidence: EvidenceFile[]
  signatures: ShipmentSignature[]
  /** 运输任务 / 证据 / 偏差 / 放行签署共用的统一版本号 */
  version: number
  updatedAt: string
}

export interface Deviation {
  id: string
  shipmentId: string
  segmentId: string
  title: string
  source: '自动监测' | '人工报告'
  severity: '一般' | '重大'
  status: DeviationStatus
  owner: string
  openedAt: string
  dueDate: string
  cause: string
  assessment: string
  disposition: '接受' | '补充处理' | '拒绝'
  correctiveAction: string
  evidence: string
  /** 调查结论引用的证据版本 */
  evidenceRefs: EvidenceRef[]
  /** 非空表示引用的证据已换版，当前调查结论与复核结论失效，须重新复核 */
  staleReason?: string
  reviewer: string
  reviewNote: string
  reviewHistory: ReviewHistoryEntry[]
  /** 偏差自身修订版本号 */
  version: number
  /** 最近一次联动时的统一版本号 */
  recordVersion: number
}

export type VersionKind =
  | '任务创建'
  | '证据版本'
  | '偏差调查'
  | '偏差复核'
  | '放行签署'
  | '签署'
  | '状态流转'
  | '写入恢复'
  | '并发冲突'
  | '外部修订'

export interface VersionRecord {
  id: string
  shipmentId: string
  /** 统一版本号；0 表示不产生新版本的事件（如冲突拦截） */
  version: number
  kind: VersionKind
  title: string
  operator: string
  detail: string
  createdAt: string
  complete: boolean
  completeAt?: string
  abandoned?: boolean
  source: '本窗口' | '其他窗口' | '系统恢复'
  correctionReason?: string
  related?: { deviationId?: string; evidenceId?: string; role?: string }
}

export interface AuditEntry {
  id: string
  shipmentId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
