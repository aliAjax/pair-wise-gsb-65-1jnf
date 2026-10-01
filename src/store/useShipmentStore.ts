import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedDeviations, seedLedger, seedShipments } from '../data/seed'
import type {
  AuditEntry, Deviation, EvidenceFile, ReviewHistoryEntry, Shipment, ShipmentSignature, ShipmentStatus, VersionKind, VersionRecord
} from '../types'

export interface OpResult {
  ok: boolean
  message: string
  conflict?: boolean
}

export interface InvestigationPatch {
  cause: string
  assessment: string
  disposition: Deviation['disposition']
  evidence: string
  correctiveAction: string
  evidenceIds: string[]
}

/** 可重放的写入描述符：写入失败后只补这一项，不重做整条版本链 */
export type OpDescriptor =
  | { kind: 'add-evidence'; name: string; category: EvidenceFile['category']; uploadedBy: string; correctionReason?: string }
  | { kind: 'verify-evidence'; evidenceId: string; verifier: string }
  | { kind: 'create-deviation'; segmentId: string; title: string; severity: Deviation['severity']; owner: string }
  | { kind: 'save-investigation'; deviationId: string; patch: InvestigationPatch }
  | { kind: 'review'; deviationId: string; disposition: Deviation['disposition']; note: string; reviewer: string }
  | { kind: 'sign'; role: ShipmentSignature['role']; comment: string; decision: '已签' | '已退回' }
  | { kind: 'release' }

export interface PendingWrite {
  id: string
  shipmentId: string
  label: string
  /** 发起写入时所依据的统一版本，恢复时仍须一致 */
  baseVersion: number
  createdAt: string
  descriptor: OpDescriptor
}

interface ShipmentState {
  shipments: Shipment[]
  deviations: Deviation[]
  ledger: VersionRecord[]
  audit: AuditEntry[]
  pendingWrites: PendingWrite[]
  failNextWrite: boolean
  keyword: string
  status: ShipmentStatus | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: ShipmentStatus | '全部') => void
  setFailNextWrite: (value: boolean) => void
  addEvidence: (shipmentId: string, input: { name: string; category: EvidenceFile['category']; uploadedBy: string; correctionReason?: string }, expectedVersion?: number) => OpResult
  verifyEvidence: (shipmentId: string, evidenceId: string, expectedVersion?: number) => OpResult
  sign: (shipmentId: string, role: ShipmentSignature['role'], comment: string, decision: '已签' | '已退回', expectedVersion?: number) => OpResult
  createDeviation: (shipmentId: string, segmentId: string, title: string, severity: Deviation['severity'], expectedVersion?: number) => OpResult
  saveInvestigation: (id: string, patch: InvestigationPatch, expectedVersion?: number) => OpResult
  reviewDeviation: (id: string, disposition: Deviation['disposition'], note: string, expectedVersion?: number) => OpResult
  release: (shipmentId: string, expectedVersion?: number) => OpResult
  simulateRemoteChange: (shipmentId: string) => void
  retryPendingWrite: (id: string) => OpResult
  discardPendingWrite: (id: string) => void
  reset: () => void
}

const STORAGE_KEY = 'gsb65:unified-version-v2'
let idSeed = 100
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`

const opLabel = (descriptor: OpDescriptor): string => {
  switch (descriptor.kind) {
    case 'add-evidence': return `上传证据 ${descriptor.name}（${descriptor.category}）`
    case 'verify-evidence': return `核验证据 ${descriptor.evidenceId}`
    case 'create-deviation': return `登记偏差 ${descriptor.title}`
    case 'save-investigation': return `提交偏差调查 ${descriptor.deviationId}`
    case 'review': return `偏差复核 ${descriptor.deviationId}：${descriptor.disposition}`
    case 'sign': return `${descriptor.role}${descriptor.decision}`
    case 'release': return '放行审核'
  }
}

interface WorkingState {
  shipments: Shipment[]
  deviations: Deviation[]
  ledger: VersionRecord[]
}

class OpError extends Error {}

/** 在克隆状态上执行一次写入，返回该写入产生的统一版本记录；校验失败抛 OpError，不改动真实状态 */
function applyOp(w: WorkingState, shipmentId: string, descriptor: OpDescriptor, source: VersionRecord['source'], nowIso: string): Omit<VersionRecord, 'id'> {
  const shipment = w.shipments.find((item) => item.id === shipmentId)
  if (!shipment) throw new OpError('运输任务不存在')
  const newVersion = shipment.version + 1
  const now = nowIso.replace('T', ' ').slice(0, 16)
  let recordKind: VersionKind
  let title: string
  let detail: string
  let related: VersionRecord['related'] | undefined
  let correctionReason: string | undefined

  const bump = () => { shipment.version = newVersion; shipment.updatedAt = nowIso }

  if (descriptor.kind === 'add-evidence') {
    const { name, category, uploadedBy, correctionReason: reason } = descriptor
    if (shipment.status === '已放行' && !reason?.trim()) {
      throw new OpError('放行后的证据更正必须填写原因，系统将另存原因版本')
    }
    correctionReason = reason?.trim() || undefined
    const sameCategory = shipment.evidence.filter((item) => item.category === category)
    const fileVersion = sameCategory.length + 1
    const oldIds = new Set(sameCategory.map((item) => item.id))
    sameCategory.forEach((item) => { item.state = '已废止'; item.supersededByRecord = newVersion })
    const evidenceId = nextId('E')
    shipment.evidence.unshift({
      id: evidenceId, name, category, version: fileVersion, recordVersion: newVersion, state: '现行',
      correctionReason, uploadedBy, uploadedAt: nowIso, verified: false
    })

    // 引用旧证据版本的调查结论失效，受影响偏差全部回到“待重新复核”
    const reopened: string[] = []
    w.deviations.filter((item) => item.shipmentId === shipmentId).forEach((deviation) => {
      const hit = deviation.evidenceRefs.find((ref) => oldIds.has(ref.evidenceId))
      if (!hit) return
      deviation.staleReason = `调查结论引用的${hit.category} V${hit.evidenceVersion}已被V${fileVersion}替代，原结论失效，须重新复核`
      deviation.status = '待重新复核'
      deviation.version += 1
      deviation.recordVersion = newVersion
      deviation.reviewHistory.forEach((entry) => { if (!entry.superseded) entry.superseded = true })
      deviation.reviewer = ''
      deviation.reviewNote = ''
      reopened.push(`${deviation.id}（原引用${hit.category} V${hit.evidenceVersion}）`)
    })

    // 放行签署随证据换版撤回，原意见保留
    const releaseSig = shipment.signatures.find((item) => item.role === '放行人员')
    let withdrawn = false
    if (releaseSig?.status === '已签') {
      releaseSig.history.push({ status: '已撤回', name: releaseSig.name, comment: releaseSig.comment, signedAt: nowIso, reason: reason?.trim() || `证据${category}换版V${fileVersion}，放行依据变更`, recordVersion: newVersion })
      releaseSig.status = '已撤回'
      releaseSig.withdrawnAt = nowIso
      releaseSig.withdrawReason = reason?.trim() || `证据${category}换版，放行依据变更`
      withdrawn = true
    }
    if (shipment.status === '已放行') shipment.status = '待放行'

    bump()
    recordKind = '证据版本'
    title = `上传证据：${name}（${category} V${fileVersion}）`
    detail = [
      `统一版本升至V${newVersion}`,
      sameCategory.length ? `同分类${sameCategory.length}个旧版本标记废止` : '该分类首个版本',
      reopened.length ? `受影响偏差重新复核：${reopened.join('、')}，原复核意见归档保留` : '无偏差引用旧版本，既有结论继续有效',
      withdrawn ? '放行签署已撤回，原签署意见保留，须重新签署放行' : '',
      correctionReason ? `放行后更正原因：${correctionReason}` : ''
    ].filter(Boolean).join('；')
    related = { evidenceId }
  } else if (descriptor.kind === 'verify-evidence') {
    const evidence = shipment.evidence.find((item) => item.id === descriptor.evidenceId)
    if (!evidence) throw new OpError('证据不存在')
    if (evidence.state === '已废止') throw new OpError('已废止版本不能核验，请核验现行版本')
    if (evidence.verified) throw new OpError('该证据已核验')
    evidence.verified = true
    bump()
    recordKind = '证据版本'
    title = `核验证据：${evidence.name}`
    detail = `${evidence.category} V${evidence.version} 核验通过，统一版本升至V${newVersion}`
    related = { evidenceId: evidence.id }
  } else if (descriptor.kind === 'create-deviation') {
    const deviation: Deviation = {
      id: nextId('TDEV'), shipmentId, segmentId: descriptor.segmentId, title: descriptor.title, source: '人工报告',
      severity: descriptor.severity, status: '待调查', owner: descriptor.owner, openedAt: nowIso,
      dueDate: nowIso.slice(0, 10), cause: '', assessment: '', disposition: '补充处理', correctiveAction: '',
      evidence: '', evidenceRefs: [], reviewer: '', reviewNote: '', reviewHistory: [], version: 1, recordVersion: newVersion
    }
    w.deviations.unshift(deviation)
    if (shipment.status === '已放行') shipment.status = '待放行'
    bump()
    recordKind = '偏差调查'
    title = `登记温度偏差：${descriptor.title}`
    detail = `偏差${deviation.id}进入调查队列，统一版本升至V${newVersion}`
    related = { deviationId: deviation.id }
  } else if (descriptor.kind === 'save-investigation') {
    const deviation = w.deviations.find((item) => item.id === descriptor.deviationId)
    if (!deviation || deviation.shipmentId !== shipmentId) throw new OpError('偏差不存在')
    if (deviation.status === '已关闭' && !deviation.staleReason) throw new OpError('偏差已关闭，调查结论不可修改')
    const { patch } = descriptor
    if (!patch.cause.trim() || !patch.assessment.trim()) throw new OpError('原因调查与影响评估必须完整填写')
    const refs = patch.evidenceIds.map((evidenceId) => {
      const evidence = shipment.evidence.find((item) => item.id === evidenceId)
      if (!evidence) throw new OpError('引用证据不存在')
      return { evidenceId, category: evidence.category, evidenceVersion: evidence.version, recordVersion: evidence.recordVersion }
    })
    deviation.cause = patch.cause
    deviation.assessment = patch.assessment
    deviation.disposition = patch.disposition
    deviation.evidence = patch.evidence
    deviation.correctiveAction = patch.correctiveAction
    deviation.evidenceRefs = refs
    deviation.staleReason = undefined
    deviation.status = '待放行复核'
    deviation.version += 1
    deviation.recordVersion = newVersion
    bump()
    recordKind = '偏差调查'
    title = `提交偏差调查：${deviation.id}`
    detail = `调查结论引用${refs.length ? refs.map((ref) => `${ref.category} V${ref.evidenceVersion}`).join('、') : '未选择证据版本'}，提交放行复核，统一版本升至V${newVersion}`
    related = { deviationId: deviation.id }
  } else if (descriptor.kind === 'review') {
    const deviation = w.deviations.find((item) => item.id === descriptor.deviationId)
    if (!deviation || deviation.shipmentId !== shipmentId) throw new OpError('偏差不存在')
    if (deviation.status !== '待放行复核') throw new OpError('仅“待放行复核”状态可复核；证据换版后须先重新提交调查')
    if (descriptor.disposition === '拒绝' && !descriptor.note.trim()) throw new OpError('拒绝放行必须填写理由')
    deviation.disposition = descriptor.disposition
    deviation.reviewer = descriptor.reviewer
    deviation.reviewNote = descriptor.note
    deviation.status = '已关闭'
    deviation.version += 1
    deviation.recordVersion = newVersion
    const entry: ReviewHistoryEntry = {
      disposition: descriptor.disposition, reviewer: descriptor.reviewer, reviewNote: descriptor.note,
      reviewedAt: nowIso, evidenceVersion: deviation.evidenceRefs.map((ref) => `${ref.category} V${ref.evidenceVersion}`).join('、') || '未引用',
      recordVersion: newVersion, superseded: false
    }
    deviation.reviewHistory.push(entry)
    if (descriptor.disposition === '拒绝') shipment.status = '已拒绝'
    bump()
    recordKind = '偏差复核'
    title = `偏差复核${descriptor.disposition}：${deviation.id}`
    detail = `复核人${descriptor.reviewer}，引用${entry.evidenceVersion}；${descriptor.note || '同意调查结论'}。统一版本升至V${newVersion}`
    related = { deviationId: deviation.id }
  } else if (descriptor.kind === 'sign') {
    const signature = shipment.signatures.find((item) => item.role === descriptor.role)
    if (!signature) throw new OpError('签收角色不存在')
    if (descriptor.decision === '已退回' && !descriptor.comment.trim()) throw new OpError('退回必须填写原因')
    if (descriptor.role === '放行人员' && descriptor.decision === '已签') {
      const open = w.deviations.some((item) => item.shipmentId === shipmentId && item.status !== '已关闭')
      if (open) throw new OpError('存在未关闭或待重新复核偏差，放行签署被拦截')
      if (shipment.evidence.some((item) => !item.verified)) throw new OpError('仍有证据未核验，不能放行签署')
      if (shipment.signatures.some((item) => item.role !== '放行人员' && item.status !== '已签')) throw new OpError('多角色签收未完成，不能放行签署')
    }
    signature.status = descriptor.decision
    signature.comment = descriptor.comment
    signature.signedAt = nowIso
    signature.withdrawnAt = undefined
    signature.withdrawReason = undefined
    signature.history.push({ status: descriptor.decision, name: signature.name, comment: descriptor.comment, signedAt: nowIso, recordVersion: newVersion })
    bump()
    recordKind = descriptor.role === '放行人员' ? '放行签署' : '签署'
    title = `${descriptor.role} ${descriptor.decision}`
    detail = `${signature.name}：${descriptor.comment || (descriptor.decision === '已签' ? '签署确认' : '退回补充')}。统一版本升至V${newVersion}`
    related = { role: descriptor.role }
  } else {
    const open = w.deviations.some((item) => item.shipmentId === shipmentId && item.status !== '已关闭')
    if (open) throw new OpError('存在未关闭或待重新复核温度偏差，不能放行')
    if (shipment.evidence.some((item) => !item.verified)) throw new OpError('仍有证据未核验')
    if (shipment.signatures.some((item) => item.role !== '放行人员' && item.status !== '已签')) throw new OpError('多角色签收未完成')
    const releaseSig = shipment.signatures.find((item) => item.role === '放行人员')
    if (releaseSig?.status !== '已签') throw new OpError('放行人员尚未签署，不能流转放行')
    shipment.status = '已放行'
    bump()
    recordKind = '状态流转'
    title = '运输任务放行'
    detail = `全部证据核验、偏差关闭、多角色签署齐备，状态流转为已放行，统一版本升至V${newVersion}`
  }

  return {
    shipmentId, version: newVersion, kind: recordKind, title, operator: operatorOf(descriptor, shipment),
    detail, createdAt: nowIso, complete: true, completeAt: nowIso, source, related, correctionReason
  }
}

function operatorOf(descriptor: OpDescriptor, shipment: Shipment): string {
  const sigName = descriptor.kind === 'sign' ? shipment.signatures.find((item) => item.role === descriptor.role)?.name : undefined
  switch (descriptor.kind) {
    case 'add-evidence': return descriptor.uploadedBy
    case 'verify-evidence': return descriptor.verifier
    case 'create-deviation': return descriptor.owner
    case 'save-investigation': return '温控质量组'
    case 'review': return descriptor.reviewer
    case 'sign': return sigName ?? descriptor.role
    case 'release': return '放行人员 顾言'
  }
}

export const useShipmentStore = create<ShipmentState>()(persist((set, get) => {
  /** 统一提交入口：乐观并发校验 → 失败挂起 → 原子写入 */
  const commit = (shipmentId: string, descriptor: OpDescriptor, expectedVersion?: number): OpResult => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    if (!shipment) return { ok: false, message: '运输任务不存在' }

    if (expectedVersion !== undefined && shipment.version !== expectedVersion) {
      const conflict: VersionRecord = {
        id: nextId('VR'), shipmentId, version: 0, kind: '并发冲突',
        title: `冲突版本拦截：${opLabel(descriptor)}`, operator: operatorOf(descriptor, shipment),
        detail: `本窗口基于V${expectedVersion}保存，但当前统一版本已为V${shipment.version}（其他窗口先保存）。本次处置未覆盖对方，请刷新后基于最新版本重新操作。`,
        createdAt: new Date().toISOString(), complete: true, source: '本窗口'
      }
      set((current) => ({ ledger: [conflict, ...current.ledger] }))
      return { ok: false, conflict: true, message: `检测到冲突版本：当前为V${shipment.version}，您打开的是V${expectedVersion}，未覆盖对方处置` }
    }

    // 先在克隆上试算，结构性校验失败不落任何记录
    const dryRun: WorkingState = structuredClone({ shipments: state.shipments, deviations: state.deviations, ledger: state.ledger })
    let draft: Omit<VersionRecord, 'id'>
    try {
      draft = applyOp(dryRun, shipmentId, descriptor, '本窗口', new Date().toISOString())
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '校验失败' }
    }

    if (state.failNextWrite) {
      // 写入失败：状态停在最后一个完整版本，仅登记未完成项等待恢复
      const pending: PendingWrite = {
        id: nextId('PEND'), shipmentId, label: opLabel(descriptor), baseVersion: shipment.version,
        createdAt: new Date().toISOString(), descriptor
      }
      set({ failNextWrite: false, pendingWrites: [pending, ...state.pendingWrites] })
      return { ok: false, message: `写入失败，已保留在最后完整版本V${shipment.version}；未完成项「${pending.label}」可恢复补写` }
    }

    const record: VersionRecord = { ...draft, id: nextId('VR') }
    set({ shipments: dryRun.shipments, deviations: dryRun.deviations, ledger: [record, ...dryRun.ledger] })
    return { ok: true, message: `已保存，统一版本 V${record.version}` }
  }

  return {
    shipments: seedShipments,
    deviations: seedDeviations,
    ledger: seedLedger,
    audit: seedAudit,
    pendingWrites: [],
    failNextWrite: false,
    keyword: '',
    status: '全部',
    setKeyword: (keyword) => set({ keyword }),
    setStatus: (status) => set({ status }),
    setFailNextWrite: (failNextWrite) => set({ failNextWrite }),
    addEvidence: (shipmentId, input, expectedVersion) =>
      commit(shipmentId, { kind: 'add-evidence', ...input }, expectedVersion),
    verifyEvidence: (shipmentId, evidenceId, expectedVersion) =>
      commit(shipmentId, { kind: 'verify-evidence', evidenceId, verifier: '当前用户' }, expectedVersion),
    sign: (shipmentId, role, comment, decision, expectedVersion) =>
      commit(shipmentId, { kind: 'sign', role, comment, decision }, expectedVersion),
    createDeviation: (shipmentId, segmentId, title, severity, expectedVersion) =>
      commit(shipmentId, { kind: 'create-deviation', segmentId, title, severity, owner: '温控质量组' }, expectedVersion),
    saveInvestigation: (id, patch, expectedVersion) => {
      const deviation = get().deviations.find((item) => item.id === id)
      if (!deviation) return { ok: false, message: '偏差不存在' }
      return commit(deviation.shipmentId, { kind: 'save-investigation', deviationId: id, patch }, expectedVersion)
    },
    reviewDeviation: (id, disposition, note, expectedVersion) => {
      const deviation = get().deviations.find((item) => item.id === id)
      if (!deviation) return { ok: false, message: '偏差不存在' }
      return commit(deviation.shipmentId, { kind: 'review', deviationId: id, disposition, note, reviewer: '放行人员 顾言' }, expectedVersion)
    },
    release: (shipmentId, expectedVersion) => commit(shipmentId, { kind: 'release' }, expectedVersion),
    simulateRemoteChange: (shipmentId) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      if (!shipment) return
      const working: WorkingState = structuredClone({ shipments: state.shipments, deviations: state.deviations, ledger: state.ledger })
      const target = working.shipments.find((item) => item.id === shipmentId)!
      target.version += 1
      target.updatedAt = new Date().toISOString()
      const record: VersionRecord = {
        id: nextId('VR'), shipmentId, version: target.version, kind: '外部修订',
        title: '其他窗口已保存（并发模拟）', operator: '其他窗口 / 现场岗位',
        detail: `另一窗口先提交并把统一版本推进到V${target.version}；本窗口若仍基于V${target.version - 1}保存，将看到冲突版本且不能覆盖对方处置。`,
        createdAt: new Date().toISOString(), complete: true, completeAt: new Date().toISOString(), source: '其他窗口'
      }
      set({ shipments: working.shipments, deviations: working.deviations, ledger: [record, ...working.ledger] })
    },
    retryPendingWrite: (id) => {
      const state = get()
      const pending = state.pendingWrites.find((item) => item.id === id)
      if (!pending) return { ok: false, message: '未完成项不存在' }
      const shipment = state.shipments.find((item) => item.id === pending.shipmentId)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      if (shipment.version !== pending.baseVersion) {
        const conflict: VersionRecord = {
          id: nextId('VR'), shipmentId: pending.shipmentId, version: 0, kind: '并发冲突',
          title: `恢复冲突：${pending.label}`, operator: '系统恢复',
          detail: `未完成项基于V${pending.baseVersion}，恢复时统一版本已为V${shipment.version}，不能补写到旧版本，请放弃后基于最新版本重新处置。`,
          createdAt: new Date().toISOString(), complete: true, source: '系统恢复'
        }
        set((current) => ({ ledger: [conflict, ...current.ledger], pendingWrites: current.pendingWrites.filter((item) => item.id !== id) }))
        return { ok: false, conflict: true, message: `恢复失败：版本已推进到V${shipment.version}，未完成项不能覆盖新版本` }
      }
      if (state.failNextWrite) return { ok: false, message: '故障注入仍开启，关闭后再恢复' }
      const working: WorkingState = structuredClone({ shipments: state.shipments, deviations: state.deviations, ledger: state.ledger })
      let draft: Omit<VersionRecord, 'id'>
      try {
        draft = applyOp(working, pending.shipmentId, pending.descriptor, '系统恢复', new Date().toISOString())
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '恢复失败' }
      }
      const record: VersionRecord = { ...draft, id: nextId('VR'), source: '系统恢复', title: `[恢复补写] ${draft.title}` }
      record.detail = `${draft.detail}；原写入失败于${pending.createdAt.replace('T', ' ').slice(0, 16)}，现从最后完整版本V${pending.baseVersion}补写未完成项。`
      set({
        shipments: working.shipments,
        deviations: working.deviations,
        ledger: [record, ...working.ledger],
        pendingWrites: state.pendingWrites.filter((item) => item.id !== id)
      })
      return { ok: true, message: `已从V${pending.baseVersion}恢复，补写完成，统一版本 V${record.version}` }
    },
    discardPendingWrite: (id) => {
      const state = get()
      const pending = state.pendingWrites.find((item) => item.id === id)
      if (!pending) return
      const record: VersionRecord = {
        id: nextId('VR'), shipmentId: pending.shipmentId, version: 0, kind: '写入恢复',
        title: `放弃未完成项：${pending.label}`, operator: '当前用户',
        detail: `该写入在V${pending.baseVersion}之后失败，放弃补写；版本链停在最后完整版本V${state.shipments.find((item) => item.id === pending.shipmentId)?.version}。`,
        createdAt: new Date().toISOString(), complete: true, source: '本窗口', abandoned: true
      }
      set((current) => ({ pendingWrites: current.pendingWrites.filter((item) => item.id !== id), ledger: [record, ...current.ledger] }))
    },
    reset: () => set({
      shipments: structuredClone(seedShipments),
      deviations: structuredClone(seedDeviations),
      ledger: structuredClone(seedLedger),
      audit: structuredClone(seedAudit),
      pendingWrites: [],
      failNextWrite: false,
      keyword: '',
      status: '全部'
    })
  }
}, {
  name: STORAGE_KEY,
  partialize: (state) => ({
    shipments: state.shipments, deviations: state.deviations, ledger: state.ledger, audit: state.audit,
    pendingWrites: state.pendingWrites, failNextWrite: state.failNextWrite, keyword: state.keyword, status: state.status
  })
}))

// 多窗口：另一窗口保存后，本窗口同步到同一版本记录，避免用旧状态覆盖
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const persisted = JSON.parse(event.newValue)
      if (persisted?.state) useShipmentStore.setState(persisted.state)
    } catch {
      // 忽略无法解析的跨窗口数据
    }
  })
}
