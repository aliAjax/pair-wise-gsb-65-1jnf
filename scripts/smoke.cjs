/**
 * 统一版本记录逻辑冒烟测试（无浏览器环境）
 * 运行：npm run test:logic
 * 用 esbuild 将 store 打包为 CJS 到临时目录，注入 localStorage 桩后执行。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const outDir = path.join(__dirname, '..', '.tmp-test')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
execFileSync(
  path.join(__dirname, '..', 'node_modules', '.bin', 'esbuild'),
  ['src/store/useShipmentStore.ts', '--bundle', '--format=cjs', `--outfile=${path.join(outDir, 'store.cjs')}`, '--platform=node'],
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
)

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
  clear() { this._m.clear() }
}

const { useShipmentStore } = require(path.join(outDir, 'store.cjs'))
const S = useShipmentStore.getState()
const SHIP = 'AIR-260929-02' // 种子偏差 TDEV-260929-01 引用 E-4(温度曲线)、E-5(设备报告)
const DEV = 'TDEV-260929-01'
const ship = () => useShipmentStore.getState().shipments.find((item) => item.id === SHIP)

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// 1) 基线
check('基线统一版本为V4', ship().version === 4)
check('基线偏差未失效', useShipmentStore.getState().deviations.find((d) => d.id === DEV).stale !== true)

// 2) 常补/换设备 → 引用旧版本的调查结论失效，偏差需重新复核
const r1 = S.addEvidence(SHIP, ship().version, { name: '货舱温控说明-校准后V2.pdf', category: '设备报告', uploadedBy: '测试员' })
check('换版保存成功', r1.ok)
check('统一版本前进到V5', ship().version === 5)
let dev = useShipmentStore.getState().deviations.find((d) => d.id === DEV)
check('引用旧证据的调查结论失效(stale)', dev.stale === true)
check('旧证据E-5标记已替代', ship().evidence.find((e) => e.id === 'E-5').superseded === true)
check('新证据版本号V2', ship().evidence.find((e) => e.name.includes('V2')).version === 2)

// 3) 放行签署撤回且原意见保留
const carrier = ship().signatures.find((s) => s.role === '承运方')
check('承运方签署被撤回', carrier.status === '已撤回')
check('承运方原意见保留在history', carrier.history.some((h) => h.comment.includes('温度波动已报告')))
check('撤回后当前意见清空', carrier.comment === '')

// 4) 失效时禁止放行复核 / 禁止放行
check('失效状态禁止放行复核', S.reviewDeviation(DEV, ship().version, '接受', 'ok').ok === false)
check('失效状态禁止放行', S.setShipmentStatus(SHIP, ship().version, '已放行').ok === false)

// 5) 重新复核必须改选最新证据
const r5 = S.saveInvestigation(DEV, ship().version, { cause: 'x', assessment: 'y', disposition: '接受', correctiveAction: 'z', evidence: 'e', evidenceRefs: ['E-5'] })
check('引用已替代证据被拒', r5.ok === false)
const newEvidId = ship().evidence.find((e) => e.name.includes('V2')).id
const r6 = S.saveInvestigation(DEV, ship().version, { cause: 'new', assessment: 'new', disposition: '接受', correctiveAction: 'z', evidence: 'e', evidenceRefs: ['E-4', newEvidId] })
check('基于最新证据重新复核成功', r6.ok)
dev = useShipmentStore.getState().deviations.find((d) => d.id === DEV)
check('重新复核后stale清除', dev.stale !== true)
check('偏差recordVersion锚定新版本', dev.recordVersion === ship().version)

// 6) 两窗口冲突：后到一方基于旧版本保存被拦截
const staleBase = ship().version - 1
const r7 = S.addEvidence(SHIP, staleBase, { name: '并发窗口文件.pdf', category: '包装确认', uploadedBy: '后到窗口' })
check('基于旧版本保存被冲突拦截', !r7.ok && Boolean(r7.conflict))
check('冲突拦截不改变版本', ship().version === staleBase + 1)
check('审计记录冲突事件', useShipmentStore.getState().audit.some((a) => a.action === '保存冲突拦截'))

// 7) 关闭偏差并满足签收/核验后放行
S.reviewDeviation(DEV, ship().version, '接受', '同意')
ship().evidence.filter((e) => !e.verified && !e.superseded).forEach((e) => S.verifyEvidence(SHIP, ship().version, e.id))
;['发货方', '承运方', '收货方'].forEach((role) => {
  if (ship().signatures.find((s) => s.role === role).status !== '已签') S.sign(SHIP, ship().version, role, `${role}重新签署`, '已签')
})
const r8 = S.setShipmentStatus(SHIP, ship().version, '已放行')
check('放行成功（已替代旧证据不阻断）', r8.ok)
check('记录放行锚定版本', ship().releasedAtVersion === ship().version)

// 8) 放行后更正：另存原因版本，锚定不变、签署不撤回
const anchor = ship().releasedAtVersion
const r9 = S.addEvidence(SHIP, ship().version, { name: '客户复检报告.pdf', category: '设备报告', uploadedBy: 'QA', reason: '客户复检发现校准证书需更新' })
check('放行后更正成功', r9.ok)
check('放行锚定版本不变', ship().releasedAtVersion === anchor)
check('任务仍为已放行', ship().status === '已放行')
check('更正条目带原因', ship().recordLedger.some((v) => v.kind === '放行后更正' && v.reason.includes('校准证书')))

// 9) 写入失败 → 回滚最后完整版本 → 恢复只补未完成项
S.reset()
const vComplete = ship().version
S.armFailure(SHIP)
const r10 = S.addEvidence(SHIP, ship().version, { name: '恢复测试设备报告.pdf', category: '设备报告', uploadedBy: '测试' })
check('注入失败后回滚到完整版本', !r10.ok && ship().version === vComplete)
check('生成恢复计划', useShipmentStore.getState().recoveryPlans.some((p) => p.shipmentId === SHIP))
check('失败未写入证据', !ship().evidence.some((e) => e.name === '恢复测试设备报告.pdf'))
const r11 = S.resumeRecovery(SHIP, ship().version)
check('恢复成功', r11.ok)
check('恢复后证据补齐', ship().evidence.some((e) => e.name === '恢复测试设备报告.pdf'))
check('恢复计划已清除', !useShipmentStore.getState().recoveryPlans.some((p) => p.shipmentId === SHIP))
check('恢复版本含重放/补录记录', ship().recordLedger.some((v) => v.kind === '故障恢复' && v.recovered.supplemented.length > 0 && v.recovered.replayed.length > 0))

// 10) 恢复基线漂移（其它窗口已先写入）→ 拒绝覆盖
S.reset()
S.armFailure(SHIP)
S.addEvidence(SHIP, ship().version, { name: 'X.pdf', category: '包装确认', uploadedBy: 't' })
S.addEvidence(SHIP, ship().version, { name: 'Y.pdf', category: '交接签字', uploadedBy: 'other' })
check('基线漂移时拒绝恢复', S.resumeRecovery(SHIP, ship().version - 1).ok === false)

fs.rmSync(outDir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
