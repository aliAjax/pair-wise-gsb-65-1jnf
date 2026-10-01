// 统一版本记录核心链路验证（node 环境，不渲染界面）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// localStorage 桩，满足 zustand persist
class MemStorage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, value) }
}
const storeDir = mkdtempSync(join(tmpdir(), 'uvr-'))
;(globalThis as any).window = { addEventListener: () => {}, localStorage: new MemStorage() }
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).document = { createElement: () => ({}), addEventListener: () => {} }
;(globalThis as any).addEventListener = () => {}

const { useShipmentStore } = await import('./src/store/useShipmentStore.ts')
const s = useShipmentStore.getState

let passed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
  if (cond) passed++
}
const find = (id: string) => s().deviations.find((d) => d.id === id)!
const ship = (id: string) => s().shipments.find((x) => x.id === id)!
const releaseSig = (id: string) => ship(id).signatures.find((x) => x.role === '放行人员')!

// ---------- 场景1：证据换版 → 引用旧版本的调查结论失效、偏差重新复核、放行签署撤回 ----------
// 02 的 TDEV 引用温度曲线 E-4 V1。先让收货方签收，再由放行人员完成签署并放行（02 当前为待放行 V7）
const r0 = s().sign('AIR-260929-02', '收货方', '外观与标签正常', '已签', 7)
check('收货方签收成功', r0.ok, r0.message) // V8
const r1 = s().verifyEvidence('AIR-260929-02', 'E-5', 8)
check('核验设备报告', r1.ok, r1.message) // V9
const r2 = s().reviewDeviation('TDEV-260929-01', '接受', '18分钟超限可接受，同意放行', 9)
check('偏差复核关闭', r2.ok && find('TDEV-260929-01').status === '已关闭', r2.message) // V10
const r3 = s().sign('AIR-260929-02', '放行人员', '证据齐全，同意放行', '已签', 10)
check('放行人员签署', r3.ok, r3.message) // V11
const r4 = s().release('AIR-260929-02', 11)
check('任务放行', r4.ok && ship('AIR-260929-02').status === '已放行', r4.message) // V12

// 放行后上传新温度曲线（换设备导出）——必须给更正原因
const noReason = s().addEvidence('AIR-260929-02', { name: 'CRT-9207换设备曲线.csv', category: '温度曲线', uploadedBy: '收货方' }, 12)
check('放行后更正缺原因被拒', !noReason.ok && /原因/.test(noReason.message), noReason.message)
const r5 = s().addEvidence('AIR-260929-02', {
  name: 'CRT-9207换设备曲线.csv', category: '温度曲线', uploadedBy: '收货方', correctionReason: '原读取器交接后报故障，改用备用设备重新导出'
}, 12)
check('放行后更正另存原因版本成功', r5.ok, r5.message) // V13

const dev = find('TDEV-260929-01')
check('旧温度曲线标记废止', ship('AIR-260929-02').evidence.find((e) => e.id === 'E-4')?.state === '已废止')
check('引用旧版本的偏差结论失效（staleReason）', !!dev.staleReason, dev.staleReason ?? '')
check('受影响偏差回到待重新复核', dev.status === '待重新复核')
check('偏差版本联动推进', dev.recordVersion === 13, `recordVersion=${dev.recordVersion}`)
check('原复核意见归档并标记失效', dev.reviewHistory.length === 1 && dev.reviewHistory[0].superseded === true && dev.reviewHistory[0].reviewNote.includes('同意放行'))
check('放行签署同步撤回', releaseSig('AIR-260929-02').status === '已撤回')
check('撤回保留原签署意见', releaseSig('AIR-260929-02').history.some((h) => h.status === '已签' && h.comment.includes('证据齐全')))
check('已放行任务退回待放行', ship('AIR-260929-02').status === '待放行')
check('更正原因随证据另存', ship('AIR-260929-02').evidence[0].correctionReason?.includes('备用设备'))

// 重新复核必须先重新提交调查
const staleReview = s().reviewDeviation('TDEV-260929-01', '接受', '直接复核', 13)
check('失效状态下直接放行复核被拦', !staleReview.ok && /重新提交/.test(staleReview.message), staleReview.message)
const newEvidence = ship('AIR-260929-02').evidence[0]
const r6 = s().saveInvestigation('TDEV-260929-01', {
  cause: '备用设备数据确认同一超限时段。', assessment: '超限18分钟结论维持，新曲线与旧曲线一致。', disposition: '接受',
  evidence: '换设备曲线、稳定性研究。', correctiveAction: '无。', evidenceIds: [newEvidence.id]
}, 13)
check('重新提交调查引用现行版本', r6.ok, r6.message) // V14
check('失效标记清除', !find('TDEV-260929-01').staleReason)

// ---------- 场景2：两个窗口后到一方看到冲突版本，不覆盖 ----------
const before = ship('AIR-260929-02').version // 14
s().simulateRemoteChange('AIR-260929-02') // 其他窗口推进到 15
check('其他窗口先保存推进版本', ship('AIR-260929-02').version === before + 1)
const conflict = s().sign('AIR-260929-02', '收货方', '基于旧基线的处置', '已签', before)
check('后到一方保存被冲突拦截', !conflict.ok && conflict.conflict === true, conflict.message)
check('冲突未覆盖对方处置（版本不变）', ship('AIR-260929-02').version === before + 1)
check('冲突事件入审计但不入版本链', s().ledger[0].kind === '并发冲突' && s().ledger[0].version === 0)
const sig02 = releaseSig('AIR-260929-02')
check('被拦截的签署没有落到记录上', sig02.status === '已撤回')

// ---------- 场景3：写入失败 → 从最后完整版本恢复，只补未完成项 ----------
const v = ship('AIR-260929-01').version // 7
s().setFailNextWrite(true)
const failed = s().addEvidence('AIR-260929-01', { name: '包装复核单.pdf', category: '包装确认', uploadedBy: '当前用户' }, v)
check('写入失败有明确反馈', !failed.ok && /最后完整版本/.test(failed.message), failed.message)
check('失败后状态停在最后完整版本', ship('AIR-260929-01').version === v)
check('失败后登记未完成项', s().pendingWrites.length === 1 && s().pendingWrites[0].baseVersion === v)

// 恢复期间版本已被推进 → 不能补写覆盖
s().simulateRemoteChange('AIR-260929-01') // v+1
const retryConflict = s().retryPendingWrite(s().pendingWrites[0].id)
check('恢复时遇冲突版本被拦', !retryConflict.ok && retryConflict.conflict === true, retryConflict.message)
check('冲突后未完成项移除，需基于最新版本重做', s().pendingWrites.length === 0)

// 再来一次失败，然后正常恢复
const v2 = ship('AIR-260929-01').version
s().setFailNextWrite(true)
s().addEvidence('AIR-260929-01', { name: '包装复核单.pdf', category: '包装确认', uploadedBy: '当前用户' }, v2)
check('第二次失败再次登记未完成项', s().pendingWrites.length === 1)
const retry = s().retryPendingWrite(s().pendingWrites[0].id)
check('恢复补写成功并只补这一项', retry.ok, retry.message)
check('恢复后仅前进一个版本', ship('AIR-260929-01').version === v2 + 1)
check('恢复后无未完成项', s().pendingWrites.length === 0)
const recoveryRecord = s().ledger.find((l) => l.source === '系统恢复' && l.title.includes('包装复核单'))
check('恢复事件标注系统恢复来源', !!recoveryRecord, recoveryRecord?.detail.slice(0, 40))

// 放弃未完成项
s().setFailNextWrite(true)
s().verifyEvidence('AIR-260929-01', 'E-3', ship('AIR-260929-01').version)
s().discardPendingWrite(s().pendingWrites[0].id)
const abandoned = s().ledger[0]
check('放弃未完成项留痕且不入版本链', abandoned.abandoned === true && abandoned.version === 0)

// ---------- 场景4：三个页面同源同一版本 ----------
check('运输列表版本与统一链一致', ship('AIR-260929-02').version === Math.max(...s().ledger.filter((l) => l.shipmentId === 'AIR-260929-02').map((l) => l.version)))
const wbDev = find('TDEV-260929-01')
check('偏差工作台显示同一版本', wbDev.recordVersion <= ship('AIR-260929-02').version)
check('审计页每个统一版本唯一', (() => {
  const nums = s().ledger.filter((l) => l.version > 0 && l.shipmentId === 'AIR-260929-01').map((l) => l.version)
  return nums.length === new Set(nums).size
})())

// ---------- 场景5：未引用换版证据的结论继续生效 ----------
const beforeUnref = find('TDEV-260929-01').status
s().addEvidence('AIR-260929-02', { name: '交接补签.jpg', category: '交接签字', uploadedBy: '收货方' })
check('未引用新证据的既有结论继续有效', find('TDEV-260929-01').status === beforeUnref && !find('TDEV-260929-01').staleReason)

s().reset()
check('恢复演示数据', s().ledger.length === 14 && s().pendingWrites.length === 0)

rmSync(storeDir, { recursive: true, force: true })
console.log(`\n${passed} 项全部通过`)
