import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Input, Select, Table, Tag, Tooltip } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import { useShipmentStore } from '../store/useShipmentStore'
import { loadShipmentSnapshot } from '../services/api'
import type { Shipment, ShipmentStatus } from '../types'

const statusColor = (status: ShipmentStatus) => status === '已放行' ? 'success' : status === '已拒绝' ? 'error' : status === '待放行' ? 'warning' : 'processing'

export function ShipmentList() {
  const navigate = useNavigate()
  const state = useShipmentStore()
  const { isFetching } = useQuery({ queryKey: ['shipments'], queryFn: () => loadShipmentSnapshot(state.shipments), staleTime: 60000 })
  const rows = useMemo(() => state.shipments.filter((item) => {
    const text = `${item.id} ${item.product} ${item.batch} ${item.route} ${item.containerId}`.toLowerCase()
    return (!state.keyword || text.includes(state.keyword.toLowerCase())) && (state.status === '全部' || item.status === state.status)
  }), [state.shipments, state.keyword, state.status])
  const columns = [
    { title: '任务编号', dataIndex: 'id', width: 150 },
    { title: '货物', dataIndex: 'product', render: (value: string, row: Shipment) => <div><strong>{value}</strong><small className="cell-sub">{row.batch}</small></div> },
    { title: '航线', dataIndex: 'route', width: 220 },
    { title: '温控箱', dataIndex: 'containerId', width: 115 },
    { title: '范围', render: (_: unknown, row: Shipment) => `${row.tempMin} - ${row.tempMax} ℃`, width: 100 },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: ShipmentStatus) => <Tag color={statusColor(value)}>{value}</Tag> },
    {
      title: '统一版本', width: 110, render: (_: unknown, row: Shipment) => {
        const pending = state.pendingWrites.filter((item) => item.shipmentId === row.id)
        const recheck = state.deviations.some((item) => item.shipmentId === row.id && item.status === '待重新复核')
        return <Space2>
          <Tag color="blue">V{row.version}</Tag>
          {recheck && <Tooltip title="有偏差引用的证据已换版，结论失效待重新复核"><WarningOutlined className="stale-icon" /></Tooltip>}
          {pending.length > 0 && <Tooltip title={pending.map((item) => item.label).join('；')}><Badge status="error" text={<span className="pending-count">{pending.length}未完成</span>} /></Tooltip>}
        </Space2>
      }
    },
    { title: '', width: 80, render: (_: unknown, row: Shipment) => <Button type="link" onClick={() => navigate(`/shipments/${row.id}`)}>打开</Button> }
  ]
  return <section className="page">
    <header className="page-head"><div><p>温控运输中心 / 在途与待放行</p><h1>温控货物运输任务</h1></div><span className="sync">{isFetching ? '正在同步' : '统一版本记录：任务 / 证据 / 偏差 / 放行签署共用 V 号'}</span></header>
    <div className="metrics">
      <article><span>运输任务</span><strong>{state.shipments.length}</strong><small>PVG与PEK始发</small></article>
      <article><span>待放行</span><strong>{state.shipments.filter((item) => item.status === '待放行').length}</strong><small>需完成证据核验</small></article>
      <article><span>待重新复核偏差</span><strong>{state.deviations.filter((item) => item.status === '待重新复核').length}</strong><small>证据换版致结论失效</small></article>
      <article><span>待核验文件</span><strong>{state.shipments.flatMap((item) => item.evidence.filter((evidence) => evidence.state === '现行')).filter((item) => !item.verified).length}</strong><small>不得直接放行</small></article>
    </div>
    <div className="toolbar">
      <Input value={state.keyword} onChange={(event) => state.setKeyword(event.target.value)} allowClear placeholder="搜索任务、货物、批次、航线或温控箱" />
      <Select value={state.status} onChange={state.setStatus} options={['全部', '待装机', '运输中', '待放行', '已放行', '已拒绝'].map((value) => ({ label: value, value }))} />
      <Badge status="processing" text="温度点按原始时间持久化" />
    </div>
    <Table rowKey="id" size="small" columns={columns} dataSource={rows} pagination={false} />
  </section>
}

// 轻量行内布局，避免与 antd Space 的泛型冲突
function Space2({ children }: { children: ReactNode }) {
  return <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{children}</span>
}
