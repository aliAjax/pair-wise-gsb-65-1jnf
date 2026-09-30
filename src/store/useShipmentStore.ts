import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedDeviations, seedShipments } from '../data/seed'
import type { AuditEntry, Deviation, EvidenceFile, Shipment, ShipmentStatus } from '../types'

interface ShipmentState {
  shipments: Shipment[]
  deviations: Deviation[]
  audit: AuditEntry[]
  keyword: string
  status: ShipmentStatus | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: ShipmentStatus | '全部') => void
  addEvidence: (shipmentId: string, evidence: Omit<EvidenceFile, 'id' | 'version' | 'uploadedAt'>) => void
  verifyEvidence: (shipmentId: string, evidenceId: string) => void
  sign: (shipmentId: string, role: string, comment: string, status: '已签' | '已退回') => { ok: boolean; message: string }
  createDeviation: (shipmentId: string, segmentId: string, title: string, severity: '一般' | '重大') => void
  saveInvestigation: (id: string, patch: Partial<Deviation>) => void
  reviewDeviation: (id: string, disposition: Deviation['disposition'], note: string) => { ok: boolean; message: string }
  setShipmentStatus: (id: string, status: ShipmentStatus) => { ok: boolean; message: string }
  reset: () => void
}

let idSeed = 10
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`

export const useShipmentStore = create<ShipmentState>()(persist((set, get) => ({
  shipments: seedShipments,
  deviations: seedDeviations,
  audit: seedAudit,
  keyword: '',
  status: '全部',
  setKeyword: (keyword) => set({ keyword }),
  setStatus: (status) => set({ status }),
  addEvidence: (shipmentId, evidence) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    if (!shipment) return state
    const sameCount = shipment.evidence.filter((item) => item.category === evidence.category).length
    shipment.evidence.unshift({ ...evidence, id: nextId('E'), version: sameCount + 1, uploadedAt: new Date().toISOString() })
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    return { shipments: [...state.shipments], audit: [makeAudit(shipmentId, '上传证据版本', evidence.uploadedBy, `${evidence.name} 版本${sameCount + 1}`), ...state.audit] }
  }),
  verifyEvidence: (shipmentId, evidenceId) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    const evidence = shipment?.evidence.find((item) => item.id === evidenceId)
    if (!shipment || !evidence) return state
    evidence.verified = true
    shipment.version += 1
    return { shipments: [...state.shipments], audit: [makeAudit(shipmentId, '核验证据', '当前用户', evidence.name), ...state.audit] }
  }),
  sign: (shipmentId, role, comment, status) => {
    const shipment = get().shipments.find((item) => item.id === shipmentId)
    const signature = shipment?.signatures.find((item) => item.role === role)
    if (!shipment || !signature) return { ok: false, message: '签收角色不存在' }
    if (status === '已退回' && !comment.trim()) return { ok: false, message: '退回必须填写原因' }
    signature.status = status
    signature.comment = comment
    signature.signedAt = new Date().toISOString()
    shipment.version += 1
    shipment.updatedAt = signature.signedAt
    set((state) => ({ shipments: [...state.shipments], audit: [makeAudit(shipmentId, `${role}${status}`, signature.name, comment || '签署确认'), ...state.audit] }))
    return { ok: true, message: status === '已签' ? '签收成功' : '已退回并要求补充材料' }
  },
  createDeviation: (shipmentId, segmentId, title, severity) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    if (!shipment) return state
    const now = new Date().toISOString()
    const deviation: Deviation = {
      id: nextId('TDEV'), shipmentId, segmentId, title, source: '人工报告', severity, status: '待调查', owner: '温控质量组', openedAt: now,
      dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), cause: '', assessment: '', disposition: '补充处理', correctiveAction: '', evidence: '', reviewer: '', reviewNote: '', version: 1
    }
    shipment.status = '待放行'
    shipment.version += 1
    return { deviations: [deviation, ...state.deviations], shipments: [...state.shipments], audit: [makeAudit(shipmentId, '登记温度偏差', '当前用户', title), ...state.audit] }
  }),
  saveInvestigation: (id, patch) => set((state) => {
    const deviation = state.deviations.find((item) => item.id === id)
    if (!deviation || !patch.cause?.trim() || !patch.assessment?.trim()) return state
    Object.assign(deviation, patch, { status: '待放行复核', version: deviation.version + 1 })
    return { deviations: [...state.deviations], audit: [makeAudit(deviation.shipmentId, '提交偏差调查', deviation.owner, deviation.assessment), ...state.audit] }
  }),
  reviewDeviation: (id, disposition, note) => {
    const deviation = get().deviations.find((item) => item.id === id)
    if (!deviation) return { ok: false, message: '偏差不存在' }
    if (disposition === '拒绝' && !note.trim()) return { ok: false, message: '拒绝放行必须填写理由' }
    deviation.disposition = disposition
    deviation.reviewer = '放行人员 顾言'
    deviation.reviewNote = note
    deviation.status = '已关闭'
    deviation.version += 1
    const shipment = get().shipments.find((item) => item.id === deviation.shipmentId)
    if (shipment) shipment.status = disposition === '拒绝' ? '已拒绝' : '待放行'
    set((state) => ({ deviations: [...state.deviations], shipments: [...state.shipments], audit: [makeAudit(deviation.shipmentId, `偏差复核：${disposition}`, deviation.reviewer, note), ...state.audit] }))
    return { ok: true, message: `已执行${disposition}` }
  },
  setShipmentStatus: (id, status) => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === id)
    if (!shipment) return { ok: false, message: '运输任务不存在' }
    const open = state.deviations.some((item) => item.shipmentId === id && item.status !== '已关闭')
    if (status === '已放行' && open) return { ok: false, message: '存在未关闭温度偏差，不能放行' }
    if (status === '已放行' && shipment.evidence.some((item) => !item.verified)) return { ok: false, message: '仍有证据未核验' }
    if (status === '已放行' && shipment.signatures.some((item) => item.role !== '放行人员' && item.status !== '已签')) return { ok: false, message: '多角色签收未完成' }
    shipment.status = status
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    set((current) => ({ shipments: [...current.shipments], audit: [makeAudit(id, `状态流转：${status}`, '当前用户', '放行工作台操作'), ...current.audit] }))
    return { ok: true, message: `状态已更新为${status}` }
  },
  reset: () => set({ shipments: structuredClone(seedShipments), deviations: structuredClone(seedDeviations), audit: structuredClone(seedAudit), keyword: '', status: '全部' })
}), { name: 'gsb65:temperature-chain' }))

function makeAudit(shipmentId: string, action: string, operator: string, detail: string): AuditEntry {
  return { id: nextId('AUD'), shipmentId, action, operator, detail, createdAt: new Date().toISOString() }
}
