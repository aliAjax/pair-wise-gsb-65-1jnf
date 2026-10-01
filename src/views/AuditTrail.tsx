import { Button, Input, Select, Space, Table, Tag, Timeline } from 'antd'
import { useMemo, useState } from 'react'
import { useShipmentStore } from '../store/useShipmentStore'
import type { AuditEntry, Shipment } from '../types'
import { versionKindColor } from '../types'

const fmt = (iso: string) => iso ? iso.replace('T', ' ').slice(0, 16) : ''

export function AuditTrail() {
  const state = useShipmentStore()
  const [keyword, setKeyword] = useState('')
  const [shipmentId, setShipmentId] = useState<string>('全部')
  const rows = useMemo(() => state.audit.filter((item) =>
    (shipmentId === '全部' || item.shipmentId === shipmentId) &&
    `${item.shipmentId} ${item.action} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase())
  ), [state.audit, keyword, shipmentId])

  const shipment: Shipment | undefined = shipmentId === '全部' ? undefined : state.shipments.find((item) => item.id === shipmentId)

  const exportReport = () => {
    const report = { generatedAt: new Date().toISOString(), shipments: state.shipments, deviations: state.deviations, audit: state.audit }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '航空温控放行报告.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  const columns = [
    { title: '统一版本', dataIndex: 'recordVersion', width: 90, render: (value: number) => <Tag color="blue">V{value}</Tag> },
    { title: '时间', dataIndex: 'createdAt', width: 160, render: (value: string) => fmt(value) },
    { title: '运输任务', dataIndex: 'shipmentId', width: 150 },
    { title: '动作', dataIndex: 'action', width: 180, render: (value: string) => <Tag color={value.includes('冲突') || value.includes('失败') ? 'error' : value.includes('偏差') ? 'warning' : value.includes('撤回') || value.includes('失效') || value.includes('恢复') ? 'orange' : 'processing'}>{value}</Tag> },
    { title: '操作人/窗口', width: 180, render: (_: unknown, row: AuditEntry) => <><div>{row.operator}</div>{row.sessionId && <small className="muted">{row.sessionId}</small>}</> },
    { title: '说明', dataIndex: 'detail' }
  ]
  const ledgerEntries = useMemo(() => {
    if (!shipment) return state.shipments.flatMap((item) => item.recordLedger.map((entry) => ({ ...entry, shipmentId: item.id })))
    return shipment.recordLedger.map((entry) => ({ ...entry, shipmentId: shipment.id }))
  }, [shipment, state.shipments])

  return <section className="page">
    <header className="page-head">
      <div><p>温度点 / 证据版本 / 偏差结论 / 签收 / 放行决定 —— 同一版本线</p><h1>完整报告与审计</h1></div>
      <Button type="primary" onClick={exportReport}>导出完整报告</Button>
    </header>
    <div className="toolbar">
      <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear placeholder="搜索任务、动作、操作人或说明" />
      <Select value={shipmentId} onChange={setShipmentId} style={{ width: 200 }} options={[{ label: '全部运输任务', value: '全部' }, ...state.shipments.map((item) => ({ label: `${item.id}（当前V${item.version}）`, value: item.id }))]} />
      <span>共{rows.length}条审计事件</span>
    </div>

    <div className="audit-ledger">
      <div className="audit-ledger-head"><strong>统一版本记录</strong>
        <Space>
          {shipment
            ? <span>{shipment.id} 当前 <Tag color="blue">V{shipment.version}</Tag>{shipment.releasedAtVersion ? <Tag color="success">放行锚定V{shipment.releasedAtVersion}</Tag> : null}</span>
            : <span className="muted">运输列表、偏差工作台与本页显示同一版本号</span>}
        </Space>
      </div>
      <Timeline className="ledger" items={ledgerEntries.slice().reverse().map((entry) => ({
        color: entry.kind === '放行后更正' ? 'magenta' : entry.kind === '故障恢复' ? 'red' : 'blue',
        children: <div className="ledger-item">
          <div className="ledger-head"><Tag color={versionKindColor[entry.kind]}>{entry.kind}</Tag><strong>{'shipmentId' in entry ? `${(entry as { shipmentId: string }).shipmentId} · ` : ''}V{entry.version} {entry.title}</strong><span>{fmt(entry.at)} · {entry.operator}{entry.sessionId ? ` · ${entry.sessionId}` : ''}</span></div>
          <p>{entry.detail}{entry.reason ? <span className="ledger-reason">更正原因：{entry.reason}</span> : null}</p>
          {entry.affectedDeviations?.length ? <div>{entry.affectedDeviations.map((item) => <Tag key={item.id} color={item.invalidate ? 'error' : 'warning'}>{item.invalidate ? '结论失效' : '关联'}：{item.id}</Tag>)}</div> : null}
          {entry.withdrawnSignatures?.length ? <div>{entry.withdrawnSignatures.map((item) => <Tag key={item.role} color="orange">撤回：{item.role}（原V{item.atVersion}意见保留）</Tag>)}</div> : null}
        </div>
      }))} />
    </div>

    <Table<AuditEntry> rowKey="id" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 12 }} />
  </section>
}
