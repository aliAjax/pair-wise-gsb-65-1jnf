import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Badge, Button } from 'antd'
import { useShipmentStore } from './store/useShipmentStore'
import { ShipmentList } from './views/ShipmentList'
import { ShipmentDetail } from './views/ShipmentDetail'
import { DeviationWorkbench } from './views/DeviationWorkbench'
import { AuditTrail } from './views/AuditTrail'

const nav = [['/', '运输放行'], ['/deviations', '偏差调查'], ['/audit', '证据审计']]

function Shell() {
  const reset = useShipmentStore((state) => state.reset)
  const open = useShipmentStore((state) => state.deviations.filter((item) => item.status !== '已关闭').length)
  return <div className="app-shell">
    <aside>
      <div className="brand"><b>温</b><div><strong>航空温控放行台</strong><small>温度证据链与偏差闭环</small></div></div>
      <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}><span>{label}</span>{label === '偏差调查' && <Badge count={open} size="small" />}</NavLink>)}</nav>
      <div className="operation-note"><span>当前授权</span><strong>放行人员 / 质量复核</strong><small>原始温度点只读</small></div>
    </aside>
    <main>
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
