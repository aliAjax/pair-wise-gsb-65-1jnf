export type ShipmentStatus = '待装机' | '运输中' | '待放行' | '已放行' | '已拒绝'
export type DeviationStatus = '待调查' | '调查中' | '待放行复核' | '已关闭'

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
}

export interface ShipmentSignature {
  role: '发货方' | '承运方' | '收货方' | '放行人员'
  name: string
  status: '待签' | '已签' | '已退回'
  signedAt: string
  comment: string
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
  reviewer: string
  reviewNote: string
  version: number
}

export interface AuditEntry {
  id: string
  shipmentId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
