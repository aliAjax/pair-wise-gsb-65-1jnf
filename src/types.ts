export type ShipmentStatus = '待装机' | '运输中' | '待放行' | '已放行' | '已拒绝'
export type DeviationStatus = '待调查' | '调查中' | '待放行复核' | '已关闭'

/** 统一版本记录的变更类型：运输任务、温度偏差、证据版本、放行签署共用一条版本线 */
export type VersionKind =
  | '任务创建'
  | '证据换版'
  | '证据核验'
  | '偏差登记'
  | '调查更新'
  | '复核结论'
  | '角色签署'
  | '放行决定'
  | '放行后更正'
  | '故障恢复'

export const versionKindColor: Record<VersionKind, string> = {
  任务创建: 'default',
  证据换版: 'processing',
  证据核验: 'cyan',
  偏差登记: 'warning',
  调查更新: 'gold',
  复核结论: 'geekblue',
  角色签署: 'purple',
  放行决定: 'success',
  放行后更正: 'magenta',
  故障恢复: 'error'
}

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
  version: number
  uploadedBy: string
  uploadedAt: string
  verified: boolean
  /** 被同分类新版本替代后失效，引用它的调查结论随之失效 */
  superseded?: boolean
  supersededAt?: string
  supersededBy?: string
}

export interface SignatureHistory {
  status: '已签' | '已退回' | '已撤回'
  comment: string
  signedAt: string
  /** 签署时所基于的统一版本；撤回后原意见按该版本保留 */
  atVersion: number
  reason?: string
}

export interface ShipmentSignature {
  role: '发货方' | '承运方' | '收货方' | '放行人员'
  name: string
  status: '待签' | '已签' | '已退回' | '已撤回'
  signedAt: string
  comment: string
  /** 撤回/重签链路：原意见始终保留 */
  history: SignatureHistory[]
}

/** 统一版本条目：证据版本、偏差结论、放行签署都挂到运输任务的同一版本线上 */
export interface RecordVersionEntry {
  version: number
  kind: VersionKind
  title: string
  detail: string
  operator: string
  at: string
  sessionId?: string
  /** 放行后更正另存的原因 */
  reason?: string
  /** 该版本放行时的放行版本锚点 */
  released?: boolean
  /** 本版本新增的证据 */
  evidence?: { id: string; name: string; category: EvidenceFile['category']; version: number }
  /** 本版本被替代的证据 */
  supersededEvidence?: string[]
  /** 本版本受影响而需重新复核的偏差 */
  affectedDeviations?: { id: string; title: string; invalidate: boolean }[]
  /** 本版本被撤回的签署 */
  withdrawnSignatures?: { role: ShipmentSignature['role']; opinion: string; atVersion: number }[]
  /** 故障恢复：重放的已完成项与补录的未完成项 */
  recovered?: { replayed: string[]; supplemented: string[] }
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
  /** 统一版本记录号，运输列表 / 偏差工作台 / 审计页显示同一值 */
  version: number
  updatedAt: string
  recordLedger: RecordVersionEntry[]
  /** 放行决定锚定的版本；放行后的更正只追加原因版本，不回滚放行 */
  releasedAtVersion?: number
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
  /** 引用的证据版本（evidence id 列表） */
  evidenceRefs: string[]
  reviewer: string
  reviewNote: string
  /** 偏差调查单自身修订号 */
  version: number
  /** 调查结论所基于的统一记录版本 */
  recordVersion: number
  /** 引用证据已换版 → 结论失效，必须重新复核 */
  stale?: boolean
  /** 导致失效的新证据 id */
  supersededBy?: string
}

export interface AuditEntry {
  id: string
  shipmentId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 事件发生时的统一记录版本 */
  recordVersion: number
  /** 写入窗口标识，用于审计多窗口冲突 */
  sessionId?: string
}

export interface VersionConflict {
  baseVersion: number
  currentVersion: number
  latest: RecordVersionEntry
}

export interface SaveResult {
  ok: boolean
  message: string
  conflict?: VersionConflict
}

/** 写入失败后的恢复计划：从最后一个完整版本恢复，仅补录未完成项 */
export interface RecoveryStep {
  key: 'evidence' | 'invalidate' | 'withdraw'
  label: string
  state: '已完成' | '未完成'
}

export interface RecoveryPlan {
  shipmentId: string
  lastCompleteVersion: number
  failedAt: string
  reason?: string
  evidenceName: string
  evidenceCategory: EvidenceFile['category']
  evidenceId?: string
  steps: RecoveryStep[]
}
