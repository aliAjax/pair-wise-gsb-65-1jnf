import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, Descriptions, Divider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Tooltip, message } from 'antd'
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { TemperatureChart } from '../components/TemperatureChart'
import { VersionOps } from '../components/VersionOps'
import { useShipmentStore } from '../store/useShipmentStore'
import type { Deviation, EvidenceFile, ShipmentSignature } from '../types'
import type { OpResult } from '../store/useShipmentStore'

export function ShipmentDetail() {
  const { id } = useParams()
  const state = useShipmentStore()
  const shipment = state.shipments.find((item) => item.id === id)
  const [activeSegmentId, setActiveSegmentId] = useState(shipment?.segments[0]?.id ?? '')
  const [signOpen, setSignOpen] = useState(false)
  const [deviationOpen, setDeviationOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [form] = Form.useForm()
  const [uploadForm] = Form.useForm()
  // 打开本窗口时所依据的统一版本；其他窗口先保存后这里保持旧版本，保存即触发冲突拦截
  const [baseVersion, setBaseVersion] = useState(shipment?.version ?? 0)
  useEffect(() => { const current = useShipmentStore.getState().shipments.find((item) => item.id === id); setActiveSegmentId(current?.segments[0]?.id ?? ''); setBaseVersion(current?.version ?? 0) }, [id])

  if (!shipment) return <section className="page empty">未找到运输任务</section>
  const activeSegment = shipment.segments.find((item) => item.id === activeSegmentId) ?? shipment.segments[0]
  const deviations = state.deviations.filter((item) => item.shipmentId === shipment.id)
  const openDeviations = deviations.filter((item) => item.status !== '已关闭')
  const conflictVisible = shipment.version !== baseVersion
  const pending = state.pendingWrites.filter((item) => item.shipmentId === shipment.id)

  const afterCommit = (result: OpResult) => {
    if (result.ok) {
      message.success(result.message)
      const latest = useShipmentStore.getState().shipments.find((item) => item.id === shipment.id)
      if (latest) setBaseVersion(latest.version)
    } else {
      message.error(result.message)
    }
    return result.ok
  }

  const evidenceColumns = [
    {
      title: '文件', dataIndex: 'name', render: (value: string, row: EvidenceFile) => <div>
        <strong>{value}{row.correctionReason && <Tag color="orange" className="inline-tag">放行后更正</Tag>}</strong>
        <small className="cell-sub">{row.category} · 文件V{row.version} · 写入于统一V{row.recordVersion}</small>
        {row.correctionReason && <small className="cell-sub correction">更正原因：{row.correctionReason}</small>}
      </div>
    },
    { title: '版本状态', dataIndex: 'state', width: 110, render: (value: EvidenceFile['state'], row: EvidenceFile) => value === '现行'
      ? <Tag color="green">现行</Tag>
      : <Tooltip title={`已被统一V${row.supersededByRecord}的新版本替代，引用旧版本的调查结论失效`}><Tag color="default">已废止</Tag></Tooltip> },
    { title: '上传', render: (_: unknown, row: EvidenceFile) => `${row.uploadedBy} ${row.uploadedAt.replace('T', ' ').slice(0, 16)}` },
    { title: '核验', dataIndex: 'verified', width: 95, render: (value: boolean, row: EvidenceFile) => value
      ? <Tag color="success">已核验</Tag>
      : <Button size="small" disabled={row.state === '已废止'} onClick={() => afterCommit(state.verifyEvidence(shipment.id, row.id, baseVersion))}>核验</Button> }
  ]
  const sign = async () => {
    const values = await form.validateFields()
    const ok = afterCommit(state.sign(shipment.id, values.role, values.comment ?? '', values.decision, baseVersion))
    if (ok) setSignOpen(false)
  }
  const createDeviation = async () => {
    const values = await form.validateFields()
    const ok = afterCommit(state.createDeviation(shipment.id, values.segmentId, values.title, values.severity, baseVersion))
    if (ok) setDeviationOpen(false)
  }
  const upload = async () => {
    const values = await uploadForm.validateFields()
    const ok = afterCommit(state.addEvidence(shipment.id, {
      name: values.name || `${values.category}-补充材料-${new Date().toISOString().slice(11, 16).replace(':', '')}.pdf`,
      category: values.category,
      uploadedBy: '当前用户',
      correctionReason: values.correctionReason?.trim() || undefined
    }, baseVersion))
    if (ok) { setUploadOpen(false); uploadForm.resetFields() }
  }
  const release = () => afterCommit(state.release(shipment.id, baseVersion))

  return <section className="page">
    <header className="page-head detail-head">
      <div><p>{shipment.id} · {shipment.batch}</p><h1>{shipment.product}</h1></div>
      <Space><Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag><Button onClick={() => setDeviationOpen(true)}>登记偏差</Button><Button onClick={() => setSignOpen(true)}>角色签收</Button><Button type="primary" onClick={release}>放行审核</Button></Space>
    </header>
    <VersionOps shipmentId={shipment.id} expectedVersion={shipment.version} />
    {conflictVisible && <Alert className="conflict-alert" type="error" showIcon
      message={<Space wrap><strong>检测到冲突版本</strong><span>本窗口打开时基于 V{baseVersion}，统一版本记录已被推进到 V{shipment.version}。</span></Space>}
      description="其他窗口已先保存，继续提交不会覆盖对方处置；请同步最新版本、确认差异后再操作。"
      action={<Button size="small" icon={<ReloadOutlined />} onClick={() => setBaseVersion(shipment.version)}>同步到 V{shipment.version}</Button>} />}
    {pending.length > 0 && <Alert className="conflict-alert" type="warning" showIcon message={`本任务有${pending.length}项写入失败待恢复，版本停在最后完整版本 V${shipment.version}`} />}
    {openDeviations.length > 0 && <Alert type="error" showIcon message={`存在${openDeviations.length}项未关闭/待重新复核温度偏差，系统阻止放行`} />}
    <Descriptions className="summary-band" size="small" column={5} items={[
      { key: 'route', label: '运输路线', children: shipment.route },
      { key: 'box', label: '温控箱', children: shipment.containerId },
      { key: 'range', label: '允许范围', children: `${shipment.tempMin} - ${shipment.tempMax} ℃` },
      { key: 'version', label: '统一版本', children: `V${shipment.version}（窗口基线 V${baseVersion}）` },
      { key: 'updated', label: '最近更新', children: shipment.updatedAt.replace('T', ' ').slice(0, 16) }
    ]} />
    <div className="detail-grid">
      <div className="timeline-panel">
        <div className="panel-title"><h2>航段时间轴</h2><span>原始温度点不可修改</span></div>
        {shipment.segments.map((segment) => <button key={segment.id} className={activeSegment.id === segment.id ? 'active' : ''} onClick={() => setActiveSegmentId(segment.id)}>
          <div className="segment-index">{segment.id.replace('SEG-', '')}</div>
          <div><strong>{segment.from} → {segment.to}</strong><span>{segment.flight} · {segment.plannedStart.replace('T', ' ').slice(0, 16)}</span><small>操作人：{segment.handler} · {segment.note}</small></div>
          <Badge status={segment.temperature.some((item) => item.value < shipment.tempMin || item.value > shipment.tempMax) ? 'error' : 'success'} />
        </button>)}
      </div>
      <div className="chart-panel">
        <div className="panel-title"><h2>{activeSegment.from} → {activeSegment.to}</h2><span>{activeSegment.flight}</span></div>
        <TemperatureChart points={activeSegment.temperature} min={shipment.tempMin} max={shipment.tempMax} />
        <div className="segment-meta"><span>计划：{activeSegment.plannedStart.replace('T', ' ').slice(0, 16)}</span><span>实际：{activeSegment.actualStart.replace('T', ' ').slice(0, 16)} - {activeSegment.actualEnd.replace('T', ' ').slice(0, 16)}</span></div>
      </div>
    </div>
    <Tabs className="detail-tabs" items={[
      { key: 'evidence', label: `证据版本 (${shipment.evidence.length})`, children: <div><div className="tab-actions"><Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>上传证据版本</Button><span>同分类换版：旧版本废止，引用它的调查结论失效，放行签署撤回并保留原意见</span></div><Table rowKey="id" size="small" columns={evidenceColumns} dataSource={shipment.evidence} pagination={false} /></div> },
      {
        key: 'signatures', label: `签收记录 (${shipment.signatures.filter((item) => item.status === '已签').length}/${shipment.signatures.length})`, children: <div className="signature-grid">{shipment.signatures.map((item) => <SignatureCard key={item.role} item={item} />)}</div>
      },
      { key: 'deviations', label: `偏差 (${deviations.length})`, children: <Table rowKey="id" size="small" pagination={false} dataSource={deviations} columns={[
        { title: '编号', dataIndex: 'id' },
        { title: '标题', dataIndex: 'title' },
        { title: '状态', dataIndex: 'status', render: (value: Deviation['status'], row: Deviation) => <Space size={4}><Tag color={value === '已关闭' ? 'success' : value === '待重新复核' ? 'error' : 'processing'}>{value}</Tag>{row.staleReason && <Tooltip title={row.staleReason}><Tag color="warning">结论失效</Tag></Tooltip>}</Space> },
        { title: '版本', dataIndex: 'version', render: (value: number, row: Deviation) => `偏差V${value} · 统一V${row.recordVersion}` }
      ]} /> }
    ]} />
    <Modal title="多角色签收" open={signOpen} onCancel={() => setSignOpen(false)} onOk={sign} okText="提交签收">
      <Form form={form} layout="vertical" initialValues={{ role: '放行人员', decision: '已签' }}>
        <Form.Item name="role" label="签收角色" rules={[{ required: true }]}><Select options={shipment.signatures.map((item) => ({ label: item.role, value: item.role }))} /></Form.Item>
        <Form.Item name="decision" label="签收决定" rules={[{ required: true }]}><Select options={[{ label: '签署确认', value: '已签' }, { label: '退回补充', value: '已退回' }]} /></Form.Item>
        <Form.Item name="comment" label="签收意见"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="上传证据版本" open={uploadOpen} onCancel={() => setUploadOpen(false)} onOk={upload} okText="保存版本">
      <Form form={uploadForm} layout="vertical" initialValues={{ category: '包装确认' }}>
        <Form.Item name="category" label="证据分类" rules={[{ required: true }]}><Select options={['温度曲线', '设备报告', '包装确认', '交接签字'].map((value) => ({ label: value, value }))} /></Form.Item>
        <Form.Item name="name" label="文件名称（留空自动生成）"><Input placeholder="如：RKN-44018换设备导出记录.csv" /></Form.Item>
        {shipment.status === '已放行' && <Form.Item name="correctionReason" label="放行后更正原因" rules={[{ required: true, message: '放行后的更正必须填写原因，另存原因版本' }]}><Input.TextArea rows={3} placeholder="说明放行后为何补证据或换设备报告" /></Form.Item>}
        {shipment.status !== '已放行' && <Form.Item name="correctionReason" label="更正原因（可选）"><Input.TextArea rows={2} /></Form.Item>}
      </Form>
    </Modal>
    <Modal title="登记温度偏差" open={deviationOpen} onCancel={() => setDeviationOpen(false)} onOk={createDeviation} okText="创建偏差">
      <Form form={form} layout="vertical" initialValues={{ segmentId: activeSegment.id, severity: '一般' }}>
        <Form.Item name="segmentId" label="发生航段" rules={[{ required: true }]}><Select options={shipment.segments.map((item) => ({ label: `${item.from} → ${item.to}`, value: item.id }))} /></Form.Item>
        <Form.Item name="title" label="偏差描述" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
        <Form.Item name="severity" label="严重度" rules={[{ required: true }]}><Select options={['一般', '重大'].map((value) => ({ label: value, value }))} /></Form.Item>
      </Form>
    </Modal>
  </section>
}

function SignatureCard({ item }: { item: ShipmentSignature }) {
  return <Card size="small">
    <div className="signature-head"><strong>{item.role}</strong><Tag color={item.status === '已签' ? 'success' : item.status === '已退回' ? 'error' : item.status === '已撤回' ? 'warning' : 'default'}>{item.status}</Tag></div>
    <p>{item.name}</p>
    <small>{item.signedAt ? item.signedAt.replace('T', ' ').slice(0, 16) : '尚未签署'}</small>
    <Divider />
    <span>{item.comment || '暂无意见'}</span>
    {item.status === '已撤回' && <div className="withdraw-note"><Warning />撤回原因：{item.withdrawReason}（{item.withdrawnAt?.replace('T', ' ').slice(5, 16)}）<br />原签署意见已保留在历史中，须重新签署放行。</div>}
    {item.history.length > 0 && <div className="sign-history"><small>意见留痕（{item.history.length}）</small>
      {[...item.history].reverse().map((entry, index) => <div key={index} className="history-line">
        <Tag color={entry.status === '已撤回' ? 'warning' : entry.status === '已退回' ? 'error' : 'success'}>{entry.status}</Tag>
        <span>V{entry.recordVersion} · {entry.signedAt.replace('T', ' ').slice(5, 16)} · {entry.comment || '无意见'}{entry.reason ? ` · ${entry.reason}` : ''}</span>
      </div>)}
    </div>}
  </Card>
}

function Warning() { return <span className="stale-icon">⚠ </span> }
