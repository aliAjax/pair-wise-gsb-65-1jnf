import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedDeviations, seedShipments } from '../data/seed'
import { SESSION_ID } from '../services/session'
import type {
  AuditEntry, Deviation, EvidenceFile, RecordVersionEntry, RecoveryPlan, SaveResult,
  Shipment, ShipmentStatus, VersionConflict, VersionKind
} from '../types'

interface ShipmentState {
  shipments: Shipment[]
  deviations: Deviation[]
  audit: AuditEntry[]
  /** 写入失败后等待“从最后完整版本恢复”的计划（按任务索引） */
  recoveryPlans: RecoveryPlan[]
  /** 仅本窗口的演示故障注入，不持久化 */
  armFailure: (shipmentId: string) => void
  keyword: string
  status: ShipmentStatus | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: ShipmentStatus | '全部') => void
  /** 常补证据 / 换设备报告：统一换版，级联失效结论、撤回签署 */
  addEvidence: (shipmentId: string, baseVersion: number, evidence: Omit<EvidenceFile, 'id' | 'version' | 'uploadedAt' | 'verified'> & { verified?: boolean; reason?: string }) => SaveResult
  verifyEvidence: (shipmentId: string, baseVersion: number, evidenceId: string) => SaveResult
  sign: (shipmentId: string, baseVersion: number, role: string, comment: string, status: '已签' | '已退回') => SaveResult
  createDeviation: (shipmentId: string, baseVersion: number, segmentId: string, title: string, severity: '一般' | '重大') => SaveResult
  saveInvestigation: (id: string, baseVersion: number, patch: Partial<Deviation> & { evidenceRefs: string[] }) => SaveResult
  reviewDeviation: (id: string, baseVersion: number, disposition: Deviation['disposition'], note: string) => SaveResult
  setShipmentStatus: (id: string, baseVersion: number, status: ShipmentStatus) => SaveResult
  /** 从最后一个完整版本恢复：重放已完成项，只补录未完成项 */
  resumeRecovery: (shipmentId: string, baseVersion: number) => SaveResult
  discardRecovery: (shipmentId: string) => void
  reset: () => void
}

let idSeed = 10
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`
const nowIso = () => new Date().toISOString()

/** 仅本窗口生效的单次故障注入开关 */
const failureArmed = new Map<string, boolean>()

/** 引用某证据的、具有有效调查结论的偏差 */
function deviationsReferencing(deviations: Deviation[], evidenceId: string) {
  return deviations.filter((item) => item.evidenceRefs.includes(evidenceId) && (item.cause || item.assessment))
}

function ledger(version: number, kind: VersionKind, entry: Omit<RecordVersionEntry, 'version' | 'kind' | 'at' | 'sessionId'>): RecordVersionEntry {
  return { version, kind, at: nowIso(), sessionId: SESSION_ID, ...entry }
}

function auditOf(shipmentId: string, action: string, operator: string, detail: string, recordVersion: number): AuditEntry {
  return { id: nextId('AUD'), shipmentId, action, operator, detail, createdAt: nowIso(), recordVersion, sessionId: SESSION_ID }
}

export const useShipmentStore = create<ShipmentState>()(persist((set, get) => {
  /** 乐观并发：基于窗口看到的 baseVersion 校验，后到一方不能覆盖对方处置 */
  const guard = (shipment: Shipment, baseVersion: number): SaveResult | null => {
    if (shipment.version !== baseVersion) {
      const latest = shipment.recordLedger[shipment.recordLedger.length - 1]
      const conflict: VersionConflict = { baseVersion, currentVersion: shipment.version, latest }
      return {
        ok: false,
        conflict,
        message: `版本冲突：您的窗口基于V${baseVersion}，另一窗口（${latest.sessionId ?? '其它窗口'} · ${latest.operator}）已产生V${shipment.version}「${latest.title}」。已拦截覆盖，请刷新到最新版本后再处置。`
      }
    }
    return null
  }

  const recordConflictAttempt = (shipment: Shipment, baseVersion: number) => {
    set((state) => ({
      audit: [auditOf(shipment.id, '保存冲突拦截', SESSION_ID, `窗口基于V${baseVersion}保存，当前已为V${shipment.version}，拒绝覆盖`, shipment.version), ...state.audit]
    }))
  }

  /** 证据换版的完整写入单元：新增证据 → 失效引用结论 → 撤回放行签署（放行后则另存原因版本） */
  const applyEvidenceRevision = (
    draftShipment: Shipment,
    draftDeviations: Deviation[],
    draftAudit: AuditEntry[],
    params: { name: string; category: EvidenceFile['category']; uploadedBy: string; reason?: string; newId: string; newVersion: number; postRelease: boolean }
  ) => {
    const { name, category, uploadedBy, reason, newId, newVersion, postRelease } = params
    const at = nowIso()
    const previous = draftShipment.evidence.filter((item) => item.category === category && !item.superseded)

    const newFile: EvidenceFile = { id: newId, name, category, version: newVersion, uploadedBy, uploadedAt: at, verified: false }
    draftShipment.evidence.unshift(newFile)
    previous.forEach((item) => { item.superseded = true; item.supersededAt = at; item.supersededBy = newId })

    const supersededIds = previous.map((item) => item.id)
    const affected: RecordVersionEntry['affectedDeviations'] = []
    const referenced = supersededIds.flatMap((eid) => deviationsReferencing(draftDeviations, eid).map((d) => ({ d })))
    referenced.forEach(({ d }) => {
      if (!d.stale) {
        d.stale = true
        d.supersededBy = newId
        // 已关闭偏差的结论同样失效：退回调查队列，完成重新复核后才能再次放行复核
        if (d.status === '已关闭') d.status = '调查中'
        affected.push({ id: d.id, title: d.title, invalidate: true })
      }
    })

    const withdrawn: RecordVersionEntry['withdrawnSignatures'] = []
    // 放行前换版：放行签署同时撤回并保留原意见；放行后换版：放行决定锚定，不撤回，作为更正另存
    if (!postRelease) {
      draftShipment.signatures.forEach((sig) => {
        if ((sig.status === '已签' || sig.status === '已退回') && sig.signedAt) {
          sig.history.push({ status: sig.status, comment: sig.comment, signedAt: sig.signedAt, atVersion: draftShipment.version, reason: `证据${category}换版为V${newVersion}，放行签署撤回` })
          withdrawn.push({ role: sig.role, opinion: sig.comment, atVersion: draftShipment.version })
          sig.status = '已撤回'
          sig.comment = ''
          sig.signedAt = ''
        }
      })
    }

    const kind: VersionKind = postRelease ? '放行后更正' : '证据换版'
    const baseVersion = draftShipment.version
    const entry: RecordVersionEntry = {
      version: baseVersion + 1,
      kind,
      at,
      sessionId: SESSION_ID,
      title: postRelease ? `放行后更正：${category} V${newVersion}` : `${category}换版 V${newVersion}`,
      detail: name,
      operator: uploadedBy,
      reason,
      released: postRelease,
      evidence: { id: newId, name, category, version: newVersion },
      supersededEvidence: supersededIds,
      affectedDeviations: affected,
      withdrawnSignatures: withdrawn
    }
    /** 调用方负责落版本：普通换版提交本条目；故障恢复时本条目随恢复条目一起提交 */
    const appendAudit = (recordVersion: number) => {
      draftAudit.unshift(auditOf(draftShipment.id, postRelease ? '放行后证据更正' : '证据换版', uploadedBy,
        `${name} 成为${category} V${newVersion}${supersededIds.length ? `，替代 ${supersededIds.join('、')}` : ''}${affected.length ? `，${affected.length}项偏差结论失效需重新复核` : ''}${withdrawn.length ? `，撤回${withdrawn.length}个放行签署（原意见保留）` : ''}${reason ? `，更正原因：${reason}` : ''}`,
        recordVersion))
      if (withdrawn.length) {
        draftAudit.unshift(auditOf(draftShipment.id, '放行签署撤回', uploadedBy, `撤回角色：${withdrawn.map((item) => item.role).join('、')}；原意见按签署版本保留于签署历史`, recordVersion))
      }
      if (affected.length) {
        draftAudit.unshift(auditOf(draftShipment.id, '调查结论失效', '版本联动', `${affected.map((item) => item.id).join('、')} 引用的证据版本已被替代，须重新复核`, recordVersion))
      }
    }
    return { newId: newFile.id, affected, withdrawn, entry, appendAudit, at }
  }

  return {
    shipments: structuredClone(seedShipments),
    deviations: structuredClone(seedDeviations),
    audit: structuredClone(seedAudit),
    recoveryPlans: [],
    keyword: '',
    status: '全部',
    armFailure: (shipmentId) => failureArmed.set(shipmentId, true),
    setKeyword: (keyword) => set({ keyword }),
    setStatus: (status) => set({ status }),

    addEvidence: (shipmentId, baseVersion, evidence) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      if (state.recoveryPlans.some((plan) => plan.shipmentId === shipmentId)) return { ok: false, message: '存在未完成的写入恢复，请先从最后完整版本恢复或放弃恢复' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const postRelease = shipment.status === '已放行'
      const newVersion = Math.max(0, ...shipment.evidence.filter((item) => item.category === evidence.category).map((item) => item.version)) + 1
      const newId = nextId('E')
      const reason = evidence.reason

      // 在克隆上写入：失败时整体丢弃，原完整版本不动（最后一个完整版本恢复点）
      const draftShipment = structuredClone(shipment)
      const draftDeviations = structuredClone(state.deviations)
      const draftAudit = structuredClone(state.audit)

      const revision = applyEvidenceRevision(draftShipment, draftDeviations, draftAudit, {
        name: evidence.name, category: evidence.category, uploadedBy: evidence.uploadedBy,
        reason, newId, newVersion, postRelease
      })

      // 模拟“写入失败”：演示用单次故障注入（在结论失效/签署撤回落盘前中断）
      if (failureArmed.get(shipmentId)) {
        failureArmed.delete(shipmentId)
        const plan: RecoveryPlan = {
          shipmentId,
          lastCompleteVersion: shipment.version,
          failedAt: nowIso(),
          reason,
          evidenceName: evidence.name,
          evidenceCategory: evidence.category,
          evidenceId: newId,
          steps: [
            { key: 'evidence', label: `写入新证据版本：${evidence.category} V${newVersion}`, state: '已完成' },
            { key: 'invalidate', label: '受影响偏差重新复核（结论失效）', state: '未完成' },
            { key: 'withdraw', label: postRelease ? '放行后更正另存原因版本' : '撤回放行签署并保留原意见', state: '未完成' }
          ]
        }
        set((s) => ({
          recoveryPlans: [...s.recoveryPlans.filter((item) => item.shipmentId !== shipmentId), plan],
          audit: [auditOf(shipmentId, '写入失败回滚', SESSION_ID, `证据${evidence.category} V${newVersion}写入中断，已恢复至最后完整版本V${shipment.version}，待补录项已生成恢复计划`, shipment.version), ...s.audit]
        }))
        return { ok: false, message: `写入失败：已回滚至最后完整版本 V${shipment.version}，可从恢复面板仅补录未完成项。` }
      }

      // 正常提交：提交证据换版版本
      draftShipment.version += 1
      draftShipment.updatedAt = revision.at
      draftShipment.recordLedger.push(revision.entry)
      revision.appendAudit(draftShipment.version)
      set({ shipments: state.shipments.map((item) => item.id === shipmentId ? draftShipment : item), deviations: draftDeviations, audit: draftAudit })
      return {
        ok: true,
        message: postRelease
          ? `已作为放行后更正另存：${evidence.category} V${newVersion}（原因版本），放行V${shipment.releasedAtVersion}锚定不变，统一版本V${draftShipment.version}`
          : `${evidence.category}已换版至V${newVersion}，统一版本升至V${draftShipment.version}`
      }
    },

    resumeRecovery: (shipmentId, baseVersion) => {
      const state = get()
      const plan = state.recoveryPlans.find((item) => item.shipmentId === shipmentId)
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      if (!plan || !shipment) return { ok: false, message: '恢复计划不存在' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }
      if (shipment.version !== plan.lastCompleteVersion) {
        return { ok: false, message: `恢复基线已变化（V${plan.lastCompleteVersion} → V${shipment.version}），为避免覆盖请在最新版本上重新评估` }
      }

      const postRelease = shipment.status === '已放行'
      const newVersion = Math.max(0, ...shipment.evidence.filter((item) => item.category === plan.evidenceCategory).map((item) => item.version)) + 1
      const draftShipment = structuredClone(shipment)
      const draftDeviations = structuredClone(state.deviations)
      const draftAudit = structuredClone(state.audit)

      const { affected, withdrawn, entry, appendAudit, at } = applyEvidenceRevision(draftShipment, draftDeviations, draftAudit, {
        name: plan.evidenceName, category: plan.evidenceCategory, uploadedBy: '当前用户',
        reason: plan.reason, newId: plan.evidenceId ?? nextId('E'), newVersion, postRelease
      })

      // 恢复只产生一个版本：证据换版条目 + 故障恢复标记同版本提交（重放已完成项、补录未完成项）
      draftShipment.version += 1
      draftShipment.updatedAt = at
      entry.kind = '故障恢复'
      entry.title = `从V${plan.lastCompleteVersion}恢复：${plan.evidenceCategory} V${newVersion}`
      entry.recovered = {
        replayed: plan.steps.filter((item) => item.state === '已完成').map((item) => item.label),
        supplemented: plan.steps.filter((item) => item.state === '未完成').map((item) => item.label)
      }
      draftShipment.recordLedger.push(entry)
      appendAudit(draftShipment.version)
      draftAudit.unshift(auditOf(shipmentId, '故障恢复完成', '当前用户',
        `从最后完整版本V${plan.lastCompleteVersion}恢复；重放已完成项：${entry.recovered.replayed.join('、') || '无'}；补录未完成项：${entry.recovered.supplemented.join('、') || '无'}（受影响偏差${affected.length}项，撤回签署${withdrawn.length}个）`,
        draftShipment.version))

      set({
        shipments: state.shipments.map((item) => item.id === shipmentId ? draftShipment : item),
        deviations: draftDeviations,
        audit: draftAudit,
        recoveryPlans: state.recoveryPlans.filter((item) => item.shipmentId !== shipmentId)
      })
      return { ok: true, message: `已从V${plan.lastCompleteVersion}恢复并重放/补录完成，统一版本为V${draftShipment.version}` }
    },

    discardRecovery: (shipmentId) => set((state) => ({
      recoveryPlans: state.recoveryPlans.filter((item) => item.shipmentId !== shipmentId),
      audit: [auditOf(shipmentId, '放弃恢复', '当前用户', '未完成项不再补录，保留最后完整版本', state.shipments.find((s) => s.id === shipmentId)?.version ?? 0), ...state.audit]
    })),

    verifyEvidence: (shipmentId, baseVersion, evidenceId) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      const evidence = shipment?.evidence.find((item) => item.id === evidenceId)
      if (!shipment || !evidence) return { ok: false, message: '证据不存在' }
      if (evidence.superseded) return { ok: false, message: '该证据版本已被替代，请核验最新版本' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const draftShipment = structuredClone(shipment)
      const target = draftShipment.evidence.find((item) => item.id === evidenceId)!
      target.verified = true
      draftShipment.version += 1
      draftShipment.updatedAt = nowIso()
      draftShipment.recordLedger.push(ledger(draftShipment.version, '证据核验', { title: `核验 ${evidence.category} V${evidence.version}`, detail: evidence.name, operator: '当前用户' }))
      const draftAudit = [auditOf(shipmentId, '核验证据', '当前用户', `${evidence.name}（V${evidence.version}）`, draftShipment.version), ...structuredClone(state.audit)]
      set({ shipments: state.shipments.map((item) => item.id === shipmentId ? draftShipment : item), audit: draftAudit })
      return { ok: true, message: `已核验 ${evidence.name}，统一版本V${draftShipment.version}` }
    },

    sign: (shipmentId, baseVersion, role, comment, status) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      const signature = shipment?.signatures.find((item) => item.role === role)
      if (!shipment || !signature) return { ok: false, message: '签收角色不存在' }
      if (status === '已退回' && !comment.trim()) return { ok: false, message: '退回必须填写原因' }
      const stale = state.deviations.some((item) => item.shipmentId === shipmentId && item.stale)
      if (status === '已签' && stale && role !== '放行人员') return { ok: false, message: '存在引用旧证据版本的失效偏差结论，须重新复核后再签署' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const draftShipment = structuredClone(shipment)
      const sig = draftShipment.signatures.find((item) => item.role === role)!
      const at = nowIso()
      if (sig.signedAt) sig.history.push({ status: sig.status as '已签' | '已退回', comment: sig.comment, signedAt: sig.signedAt, atVersion: draftShipment.version })
      sig.status = status
      sig.comment = comment
      sig.signedAt = at
      draftShipment.version += 1
      draftShipment.updatedAt = at
      draftShipment.recordLedger.push(ledger(draftShipment.version, '角色签署', {
        title: `${role}${status}`,
        detail: comment || '签署确认',
        operator: sig.name
      }))
      const draftAudit = [auditOf(shipmentId, `${role}${status}`, sig.name, `${comment || '签署确认'}（基于V${baseVersion}）`, draftShipment.version), ...structuredClone(state.audit)]
      set({ shipments: state.shipments.map((item) => item.id === shipmentId ? draftShipment : item), audit: draftAudit })
      return { ok: true, message: status === '已签' ? `签收成功，统一版本V${draftShipment.version}` : '已退回并要求补充材料' }
    },

    createDeviation: (shipmentId, baseVersion, segmentId, title, severity) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === shipmentId)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const deviation: Deviation = {
        id: nextId('TDEV'), shipmentId, segmentId, title, source: '人工报告', severity, status: '待调查', owner: '温控质量组', openedAt: nowIso(),
        dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), cause: '', assessment: '', disposition: '补充处理', correctiveAction: '', evidence: '', evidenceRefs: [], reviewer: '', reviewNote: '', version: 1, recordVersion: 0
      }
      const draftShipment = structuredClone(shipment)
      draftShipment.status = '待放行'
      draftShipment.version += 1
      draftShipment.updatedAt = nowIso()
      draftShipment.recordLedger.push(ledger(draftShipment.version, '偏差登记', {
        title: `登记偏差：${title}`, detail: `严重度${severity}，航段${segmentId}`, operator: '当前用户',
        affectedDeviations: [{ id: deviation.id, title, invalidate: false }]
      }))
      deviation.recordVersion = draftShipment.version
      set((s) => ({
        deviations: [deviation, ...structuredClone(s.deviations)],
        shipments: s.shipments.map((item) => item.id === shipmentId ? draftShipment : item),
        audit: [auditOf(shipmentId, '登记温度偏差', '当前用户', `${title}（统一版本V${draftShipment.version}）`, draftShipment.version), ...structuredClone(s.audit)]
      }))
      return { ok: true, message: `已创建偏差并进入调查队列，统一版本V${draftShipment.version}` }
    },

    saveInvestigation: (id, baseVersion, patch) => {
      const state = get()
      const deviation = state.deviations.find((item) => item.id === id)
      if (!deviation) return { ok: false, message: '偏差不存在' }
      if (!patch.cause?.trim() || !patch.assessment?.trim()) return { ok: false, message: '原因调查与影响评估必须填写' }
      if (!patch.evidenceRefs?.length) return { ok: false, message: '调查结论必须引用至少一个证据版本' }
      const shipment = state.shipments.find((item) => item.id === deviation.shipmentId)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      const staleRefs = patch.evidenceRefs.filter((ref) => shipment.evidence.find((e) => e.id === ref)?.superseded)
      if (staleRefs.length) return { ok: false, message: '不能引用已被替代的旧证据版本，请改选最新证据后重新复核' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const draftDeviation = structuredClone(deviation)
      Object.assign(draftDeviation, {
        cause: patch.cause, assessment: patch.assessment, disposition: patch.disposition ?? draftDeviation.disposition,
        correctiveAction: patch.correctiveAction ?? draftDeviation.correctiveAction, evidence: patch.evidence ?? draftDeviation.evidence,
        evidenceRefs: patch.evidenceRefs
      })
      const recheck = draftDeviation.stale === true
      draftDeviation.stale = false
      draftDeviation.supersededBy = undefined
      draftDeviation.status = '待放行复核'
      draftDeviation.version += 1

      const draftShipment = structuredClone(shipment)
      draftShipment.version += 1
      draftShipment.updatedAt = nowIso()
      draftShipment.recordLedger.push(ledger(draftShipment.version, '调查更新', {
        title: recheck ? `偏差重新复核：${draftDeviation.title}` : `提交偏差调查：${draftDeviation.title}`,
        detail: recheck ? '引用证据已换版，基于新版本重新完成调查' : draftDeviation.assessment,
        operator: draftDeviation.owner,
        affectedDeviations: [{ id: draftDeviation.id, title: draftDeviation.title, invalidate: false }]
      }))
      draftDeviation.recordVersion = draftShipment.version
      set((s) => ({
        deviations: structuredClone(s.deviations).map((item) => item.id === id ? draftDeviation : item),
        shipments: s.shipments.map((item) => item.id === deviation.shipmentId ? draftShipment : item),
        audit: [auditOf(deviation.shipmentId, recheck ? '偏差重新复核' : '提交偏差调查', draftDeviation.owner,
          `${draftDeviation.title}，引用证据 ${patch.evidenceRefs.join('、')}（统一版本V${draftShipment.version}）`, draftShipment.version), ...structuredClone(s.audit)]
      }))
      return { ok: true, message: recheck ? `已基于最新证据重新复核，统一版本V${draftShipment.version}` : `调查已提交放行复核，统一版本V${draftShipment.version}` }
    },

    reviewDeviation: (id, baseVersion, disposition, note) => {
      const state = get()
      const deviation = state.deviations.find((item) => item.id === id)
      if (!deviation) return { ok: false, message: '偏差不存在' }
      if (disposition === '拒绝' && !note.trim()) return { ok: false, message: '拒绝放行必须填写理由' }
      if (deviation.stale) return { ok: false, message: '调查结论引用的证据版本已失效，须先重新复核再放行复核' }
      const shipment = state.shipments.find((item) => item.id === deviation.shipmentId)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const draftDeviation = structuredClone(deviation)
      draftDeviation.disposition = disposition
      draftDeviation.reviewer = '放行人员 顾言'
      draftDeviation.reviewNote = note
      draftDeviation.status = '已关闭'
      draftDeviation.version += 1

      const draftShipment = structuredClone(shipment)
      draftShipment.status = disposition === '拒绝' ? '已拒绝' : '待放行'
      draftShipment.version += 1
      draftShipment.updatedAt = nowIso()
      draftShipment.recordLedger.push(ledger(draftShipment.version, '复核结论', {
        title: `偏差复核：${disposition}`, detail: note || '同意调查处置', operator: draftDeviation.reviewer,
        affectedDeviations: [{ id: draftDeviation.id, title: draftDeviation.title, invalidate: false }]
      }))
      draftDeviation.recordVersion = draftShipment.version
      set((s) => ({
        deviations: structuredClone(s.deviations).map((item) => item.id === id ? draftDeviation : item),
        shipments: s.shipments.map((item) => item.id === deviation.shipmentId ? draftShipment : item),
        audit: [auditOf(deviation.shipmentId, `偏差复核：${disposition}`, draftDeviation.reviewer, `${note}（统一版本V${draftShipment.version}）`, draftShipment.version), ...structuredClone(s.audit)]
      }))
      return { ok: true, message: `已执行${disposition}，统一版本V${draftShipment.version}` }
    },

    setShipmentStatus: (id, baseVersion, status) => {
      const state = get()
      const shipment = state.shipments.find((item) => item.id === id)
      if (!shipment) return { ok: false, message: '运输任务不存在' }
      const open = state.deviations.some((item) => item.shipmentId === id && item.status !== '已关闭')
      if (status === '已放行' && open) return { ok: false, message: '存在未关闭温度偏差，不能放行' }
      if (status === '已放行' && state.deviations.some((item) => item.shipmentId === id && item.stale)) return { ok: false, message: '存在引用旧证据版本的失效偏差结论，须重新复核' }
      if (status === '已放行' && shipment.evidence.some((item) => !item.verified && !item.superseded)) return { ok: false, message: '仍有证据未核验（已替代的旧版本不阻断放行）' }
      if (status === '已放行' && shipment.signatures.some((item) => item.role !== '放行人员' && item.status !== '已签')) return { ok: false, message: '多角色签收未完成（撤回的签署需重新签署）' }
      const conflict = guard(shipment, baseVersion)
      if (conflict) { recordConflictAttempt(shipment, baseVersion); return conflict }

      const draftShipment = structuredClone(shipment)
      const at = nowIso()
      draftShipment.status = status
      draftShipment.version += 1
      draftShipment.updatedAt = at
      const released = status === '已放行'
      if (released) draftShipment.releasedAtVersion = draftShipment.version
      draftShipment.recordLedger.push(ledger(draftShipment.version, '放行决定', {
        title: `放行决定：${status}`, detail: released ? '放行签署锚定本版本，后续更正另存原因版本' : '放行工作台操作', operator: '当前用户', released
      }))
      set((s) => ({
        shipments: s.shipments.map((item) => item.id === id ? draftShipment : item),
        audit: [auditOf(id, `状态流转：${status}`, '当前用户', `放行工作台操作（统一版本V${draftShipment.version}）`, draftShipment.version), ...structuredClone(s.audit)]
      }))
      return { ok: true, message: `状态已更新为${status}，统一版本V${draftShipment.version}` }
    },

    reset: () => {
      failureArmed.clear()
      set({
        shipments: structuredClone(seedShipments),
        deviations: structuredClone(seedDeviations),
        audit: structuredClone(seedAudit),
        recoveryPlans: [],
        keyword: '',
        status: '全部'
      })
    }
  }
}, {
  name: 'gsb65:unified-records-v2',
  version: 2,
  partialize: (state) => ({ shipments: state.shipments, deviations: state.deviations, audit: state.audit, recoveryPlans: state.recoveryPlans })
}))

/** 偏差当前引用的证据是否已被替代（结论失效判定） */
export function isDeviationStale(deviation: Deviation, shipment: Shipment | undefined): boolean {
  if (deviation.stale) return true
  if (!shipment) return false
  return deviation.evidenceRefs.some((ref) => shipment.evidence.find((item) => item.id === ref)?.superseded)
}

/** 偏差结论所基于的证据条目（用于工作台显示引用版本） */
export function referencedEvidence(deviation: Deviation, shipment: Shipment | undefined): EvidenceFile[] {
  if (!shipment) return []
  return deviation.evidenceRefs.map((ref) => shipment.evidence.find((item) => item.id === ref)).filter((item): item is EvidenceFile => Boolean(item))
}
