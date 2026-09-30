import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, DatePicker, Descriptions, Divider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { TemperatureChart } from '../components/TemperatureChart'
import { useShipmentStore } from '../store/useShipmentStore'
import type { EvidenceFile, ShipmentSegment } from '../types'

export function ShipmentDetail() {
  const { id } = useParams()
  const state = useShipmentStore()
  const shipment = state.shipments.find((item) => item.id === id)
  const [activeSegmentId, setActiveSegmentId] = useState(shipment?.segments[0]?.id ?? '')
  const [signOpen, setSignOpen] = useState(false)
  const [deviationOpen, setDeviationOpen] = useState(false)
  const [form] = Form.useForm()
  if (!shipment) return <section className="page empty">未找到运输任务</section>
  const activeSegment = shipment.segments.find((item) => item.id === activeSegmentId) ?? shipment.segments[0]
  const deviations = state.deviations.filter((item) => item.shipmentId === shipment.id)
  const openDeviations = deviations.filter((item) => item.status !== '已关闭')
  const evidenceColumns = [
    { title: '文件', dataIndex: 'name', render: (value: string, row: EvidenceFile) => <div><strong>{value}</strong><small className="cell-sub">{row.category} · V{row.version}</small></div> },
    { title: '上传', render: (_: unknown, row: EvidenceFile) => `${row.uploadedBy} ${row.uploadedAt.replace('T', ' ').slice(0, 16)}` },
    { title: '核验', dataIndex: 'verified', width: 95, render: (value: boolean, row: EvidenceFile) => value ? <Tag color="success">已核验</Tag> : <Button size="small" onClick={() => state.verifyEvidence(shipment.id, row.id)}>核验</Button> }
  ]
  const sign = async () => {
    const values = await form.validateFields()
    const result = state.sign(shipment.id, values.role, values.comment ?? '', values.decision)
    result.ok ? message.success(result.message) : message.error(result.message)
    if (result.ok) setSignOpen(false)
  }
  const createDeviation = async () => {
    const values = await form.validateFields()
    state.createDeviation(shipment.id, values.segmentId, values.title, values.severity)
    setDeviationOpen(false)
    message.success('已创建偏差并进入调查队列')
  }
  const release = () => {
    const result = state.setShipmentStatus(shipment.id, '已放行')
    result.ok ? message.success(result.message) : message.error(result.message)
  }
  return <section className="page">
    <header className="page-head detail-head">
      <div><p>{shipment.id} · {shipment.batch}</p><h1>{shipment.product}</h1></div>
      <Space><Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag><Button onClick={() => setDeviationOpen(true)}>登记偏差</Button><Button onClick={() => setSignOpen(true)}>角色签收</Button><Button type="primary" onClick={release}>放行审核</Button></Space>
    </header>
    {openDeviations.length > 0 && <Alert type="error" showIcon message={`存在${openDeviations.length}项未关闭温度偏差，系统阻止放行`} />}
    <Descriptions className="summary-band" size="small" column={5} items={[
      { key: 'route', label: '运输路线', children: shipment.route },
      { key: 'box', label: '温控箱', children: shipment.containerId },
      { key: 'range', label: '允许范围', children: `${shipment.tempMin} - ${shipment.tempMax} ℃` },
      { key: 'version', label: '任务版本', children: `V${shipment.version}` },
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
      { key: 'evidence', label: `证据版本 (${shipment.evidence.length})`, children: <div><div className="tab-actions"><Upload beforeUpload={() => { state.addEvidence(shipment.id, { name: `现场补充材料-${Date.now()}.pdf`, category: '包装确认', uploadedBy: '当前用户', verified: false }); message.success('已新增证据版本'); return false }} showUploadList={false}><Button icon={<UploadOutlined />}>上传证据</Button></Upload><span>同分类文件自动递增版本</span></div><Table rowKey="id" size="small" columns={evidenceColumns} dataSource={shipment.evidence} pagination={false} /></div> },
      { key: 'signatures', label: `签收记录 (${shipment.signatures.filter((item) => item.status === '已签').length}/${shipment.signatures.length})`, children: <div className="signature-grid">{shipment.signatures.map((item) => <Card key={item.role} size="small"><div className="signature-head"><strong>{item.role}</strong><Tag color={item.status === '已签' ? 'success' : item.status === '已退回' ? 'error' : 'default'}>{item.status}</Tag></div><p>{item.name}</p><small>{item.signedAt ? item.signedAt.replace('T', ' ').slice(0, 16) : '尚未签署'}</small><Divider /><span>{item.comment || '暂无意见'}</span></Card>)}</div> },
      { key: 'deviations', label: `偏差 (${deviations.length})`, children: <Table rowKey="id" size="small" pagination={false} dataSource={deviations} columns={[{ title: '编号', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' }, { title: '状态', dataIndex: 'status' }, { title: '版本', dataIndex: 'version', render: (value: number) => `V${value}` }]} /> }
    ]} />
    <Modal title="多角色签收" open={signOpen} onCancel={() => setSignOpen(false)} onOk={sign} okText="提交签收">
      <Form form={form} layout="vertical" initialValues={{ role: '放行人员', decision: '已签' }}>
        <Form.Item name="role" label="签收角色" rules={[{ required: true }]}><Select options={shipment.signatures.map((item) => ({ label: item.role, value: item.role }))} /></Form.Item>
        <Form.Item name="decision" label="签收决定" rules={[{ required: true }]}><Select options={[{ label: '签署确认', value: '已签' }, { label: '退回补充', value: '已退回' }]} /></Form.Item>
        <Form.Item name="comment" label="签收意见"><Input.TextArea rows={3} /></Form.Item>
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
