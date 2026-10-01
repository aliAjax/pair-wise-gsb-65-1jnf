import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Badge, Button, Alert, Space, Tag } from 'antd'
import { useShipmentStore } from './store/useShipmentStore'
import { SESSION_ID } from './services/session'
import { ShipmentList } from './views/ShipmentList'
import { ShipmentDetail } from './views/ShipmentDetail'
import { DeviationWorkbench } from './views/DeviationWorkbench'
import { AuditTrail } from './views/AuditTrail'

const nav = [['/', '运输放行'], ['/deviations', '偏差调查'], ['/audit', '证据审计']]

function RecoveryBanners() {
  const plans = useShipmentStore((state) => state.recoveryPlans)
  const resume = useShipmentStore((state) => state.resumeRecovery)
  const discard = useShipmentStore((state) => state.discardRecovery)
  if (!plans.length) return null
  return <div style={{ padding: '12px 28px 0', display: 'grid', gap: 8 }}>
    {plans.map((plan) => <Alert
      key={plan.shipmentId}
      type="error" showIcon
      message={<Space wrap><b>{plan.shipmentId} 写入失败，已回滚至最后完整版本 V{plan.lastCompleteVersion}</b>
        <Tag color="red">统一版本 V{plan.lastCompleteVersion}</Tag>
        <span>未完成项：{plan.steps.filter((step) => step.state === '未完成').map((step) => step.label).join('；')}</span>
      </Space>}
      description="恢复时将从最后一个完整版本重放已完成项，只补录未完成项，不会覆盖期间其他窗口产生的处置。"
      action={<Space direction="vertical">
        <Button size="small" type="primary" onClick={() => resume(plan.shipmentId, plan.lastCompleteVersion)}>从V{plan.lastCompleteVersion}恢复</Button>
        <Button size="small" type="text" onClick={() => discard(plan.shipmentId)}>放弃（保留当前完整版本）</Button>
      </Space>}
    />)}
  </div>
}

function Shell() {
  const reset = useShipmentStore((state) => state.reset)
  const open = useShipmentStore((state) => state.deviations.filter((item) => item.status !== '已关闭').length)
  return <div className="app-shell">
    <aside>
      <div className="brand"><b>温</b><div><strong>航空温控放行台</strong><small>温度证据链与偏差闭环</small></div></div>
      <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}><span>{label}</span>{label === '偏差调查' && <Badge count={open} size="small" />}</NavLink>)}</nav>
      <div className="operation-note"><span>当前授权</span><strong>放行人员 / 质量复核</strong><small>原始温度点只读</small><small>本窗口标识 {SESSION_ID} · 用于版本冲突审计</small></div>
    </aside>
    <main>
      <RecoveryBanners />
      <Routes>
        <Route path="/" element={<ShipmentList />} />
        <Route path="/shipments/:id" element={<ShipmentDetail />} />
        <Route path="/deviations" element={<DeviationWorkbench />} />
        <Route path="/audit" element={<AuditTrail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Button className="reset" type="text" onClick={reset}>恢复演示数据</Button>
    </main>
  </div>
}

export function App() { return <BrowserRouter><Shell /></BrowserRouter> }
