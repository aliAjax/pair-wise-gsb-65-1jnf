import { useMemo, useState } from 'react'
import { Button, Empty, Input, Select, Table, Tag, Timeline } from 'antd'
import { useShipmentStore } from '../store/useShipmentStore'
import type { VersionKind, VersionRecord } from '../types'

const kindColor: Record<VersionKind, string> = {
  任务创建: 'default',
  证据版本: 'blue',
  偏差调查: 'gold',
  偏差复核: 'orange',
  放行签署: 'purple',
  签署: 'cyan',
  状态流转: 'green',
  写入恢复: 'warning',
  并发冲突: 'error',
  外部修订: 'magenta'
}

export function AuditTrail() {
  const state = useShipmentStore()
  const [keyword, setKeyword] = useState('')
  const [shipmentId, setShipmentId] = useState('全部')
  const rows = useMemo(() => state.ledger
    .filter((item) => shipmentId === '全部' || item.shipmentId === shipmentId)
    .filter((item) => `${item.shipmentId} ${item.kind} ${item.title} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.ledger, keyword, shipmentId])

  const exportReport = () => {
    const report = { generatedAt: new Date().toISOString(), shipments: state.shipments, deviations: state.deviations, versionRecords: state.ledger, pendingWrites: state.pendingWrites, legacyAudit: state.audit }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '航空温控放行报告.json'; anchor.click(); URL.revokeObjectURL(url)
  }

  const columns = [
    { title: '统一版本', dataIndex: 'version', width: 95, render: (value: number, row: VersionRecord) => value > 0
      ? <Tag color="blue">V{value}</Tag>
      : <Tag color={row.abandoned ? 'default' : 'error'}>{row.abandoned ? '未入链' : '拦截'}</Tag> },
    { title: '类型', dataIndex: 'kind', width: 100, render: (value: VersionKind) => <Tag color={kindColor[value]}>{value}</Tag> },
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (value: string) => value.replace('T', ' ').slice(0, 16) },
    { title: '运输任务', dataIndex: 'shipmentId', width: 150 },
    { title: '事件', dataIndex: 'title', width: 260 },
    { title: '操作人', dataIndex: 'operator', width: 130 },
    { title: '说明', dataIndex: 'detail' },
    { title: '来源 / 完整性', width: 150, render: (_: unknown, row: VersionRecord) => <div className="ledger-flags">
      <Tag color={row.source === '其他窗口' ? 'magenta' : row.source === '系统恢复' ? 'warning' : 'default'}>{row.source}</Tag>
      {!row.complete && <Tag color="error">未完成</Tag>}
    </div> }
  ]

  const chains = state.shipments.map((shipment) => ({ shipment, records: state.ledger.filter((item) => item.shipmentId === shipment.id && item.version > 0).sort((a, b) => b.version - a.version) }))

  return <section className="page">
    <header className="page-head"><div><p>统一版本记录 / 证据换版联动 / 并发与恢复</p><h1>完整报告与审计</h1></div><Button type="primary" onClick={exportReport}>导出完整报告</Button></header>
    <div className="ledger-chains">
      {chains.map(({ shipment, records }) => <div key={shipment.id} className="chain-card">
        <div className="chain-head"><strong>{shipment.id}</strong><Tag color="blue">V{shipment.version}</Tag><Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag></div>
        <Timeline items={records.slice(0, 4).map((record) => ({
          color: record.kind === '证据版本' ? 'blue' : record.kind === '偏差调查' || record.kind === '偏差复核' ? 'gold' : 'gray',
          children: <div className="chain-line"><Tag color={kindColor[record.kind]}>{record.kind}</Tag><span>V{record.version} {record.title}</span><small>{record.createdAt.replace('T', ' ').slice(5, 16)}</small></div>
        }))} />
      </div>)}
    </div>
    <div className="toolbar">
      <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear placeholder="搜索任务、事件、操作人或说明" />
      <Select value={shipmentId} onChange={setShipmentId} style={{ width: 180 }} options={[{ label: '全部任务', value: '全部' }, ...state.shipments.map((item) => ({ label: item.id, value: item.id }))]} />
      <span>共{rows.length}条版本事件（与运输列表、偏差工作台同一版本）</span>
    </div>
    {rows.length === 0 ? <Empty /> : <Table<VersionRecord> rowKey="id" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 12 }} />}
  </section>
}
