import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Descriptions, Empty, Form, Input, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { VersionOps } from '../components/VersionOps'
import { useShipmentStore } from '../store/useShipmentStore'
import type { Deviation } from '../types'
import type { InvestigationPatch, OpResult } from '../store/useShipmentStore'

export function DeviationWorkbench() {
  const state = useShipmentStore()
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const selected = state.deviations.find((item) => item.id === selectedId) ?? state.deviations[0]
  const [form] = Form.useForm()
  const [reviewOpen, setReviewOpen] = useState(false)
  const shipment = selected ? state.shipments.find((item) => item.id === selected.shipmentId) : undefined
  // 进入该偏差时锁定统一版本基线；证据在其他窗口/本任务详情换版后形成冲突
  const [baseVersion, setBaseVersion] = useState(shipment?.version ?? 0)
  useEffect(() => {
    const current = useShipmentStore.getState().shipments.find((item) => item.id === selected?.shipmentId)
    setBaseVersion(current?.version ?? 0)
    // 仅在切换偏差时重置基线，外部换版不应静默覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])
  useEffect(() => {
    if (selected) form.setFieldsValue({ ...selected, evidenceIds: selected.evidenceRefs.map((ref) => ref.evidenceId) })
  }, [selected, form])
  useEffect(() => { if (!selectedId && selected) setSelectedId(selected.id) }, [selectedId, selected])

  if (!selected) return <section className="page"><Empty description="暂无偏差" /></section>
  const conflictVisible = shipment ? shipment.version !== baseVersion : false

  const afterCommit = (result: OpResult) => {
    if (result.ok) {
      message.success(result.message)
      const latest = useShipmentStore.getState().shipments.find((item) => item.id === selected.shipmentId)
      if (latest) setBaseVersion(latest.version)
    } else {
      message.error(result.message)
    }
    return result.ok
  }

  const save = async () => {
    const values = await form.validateFields()
    const patch: InvestigationPatch = {
      cause: values.cause,
      assessment: values.assessment,
      disposition: values.disposition,
      evidence: values.evidence,
      correctiveAction: values.correctiveAction,
      evidenceIds: values.evidenceIds ?? []
    }
    if (afterCommit(state.saveInvestigation(selected.id, patch, baseVersion))) message.success('调查已提交放行复核')
  }
  const review = async () => {
    const values = await form.validateFields(['disposition', 'reviewNote'])
    const ok = afterCommit(state.reviewDeviation(selected.id, values.disposition, values.reviewNote ?? '', baseVersion))
    if (ok) setReviewOpen(false)
  }

  const evidenceOptions = shipment?.evidence.map((item) => ({
    label: `${item.state === '现行' ? '' : '【已废止】'}${item.category} 文件V${item.version}（写入统一V${item.recordVersion}）${item.verified ? ' · 已核验' : ' · 待核验'}`,
    value: item.id,
    disabled: item.state === '已废止'
  })) ?? []

  return <section className="page">
    <header className="page-head"><div><p>温度超限 / 原因调查 / 放行复核 / 证据换版联动</p><h1>温度偏差调查</h1></div><Badge count={state.deviations.filter((item) => item.status !== '已关闭').length} showZero /></header>
    <VersionOps shipmentId={selected.shipmentId} expectedVersion={shipment?.version} />
    {conflictVisible && <Alert className="conflict-alert" type="error" showIcon
      message={<Space wrap><strong>检测到冲突版本</strong><span>本工作台基线 V{baseVersion}，{selected.shipmentId} 当前已为 V{shipment?.version}</span></Space>}
      description="证据或签署在其他窗口先保存，本窗口的处置不能覆盖对方；同步最新版本后再提交。"
      action={<Button size="small" icon={<ReloadOutlined />} onClick={() => shipment && setBaseVersion(shipment.version)}>同步到 V{shipment?.version}</Button>} />}
    {selected.staleReason && <Alert className="conflict-alert" type="warning" showIcon
      message={<Space wrap><strong>调查结论已失效：{selected.status}</strong><Tag color="error">证据换版联动</Tag></Space>}
      description={`${selected.staleReason}。请核对现行证据版本重新提交调查，原复核意见已归档并标记失效；放行签署（如有）同步撤回并保留原意见。`} />}
    <div className="deviation-layout">
      <div className="deviation-nav">{state.deviations.map((item) => <button key={item.id} className={item.id === selected.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}><div><Badge status={item.severity === '重大' ? 'error' : 'warning'} /><strong>{item.title}</strong></div><span>{item.id}</span><small>{item.shipmentId} · 偏差V{item.version} · 统一V{item.recordVersion}</small><Space size={4}><Tag color={item.status === '已关闭' ? 'success' : item.status === '待重新复核' ? 'error' : 'processing'}>{item.status}</Tag>{item.staleReason && <Tag color="warning">结论失效</Tag>}</Space></button>)}</div>
      <div className="deviation-main">
        <div className="panel-title"><div><h2>{selected.title}</h2><span>{selected.id} · {selected.source} · 任务统一版本 V{shipment?.version}（窗口基线 V{baseVersion}）</span></div><Space><Button onClick={() => setReviewOpen(true)} disabled={selected.status !== '待放行复核'}>放行复核</Button><Button type="primary" onClick={save} disabled={selected.status === '已关闭' && !selected.staleReason}>保存并提交</Button></Space></div>
        <Descriptions size="small" column={4} items={[
          { key: 'shipment', label: '运输任务', children: selected.shipmentId },
          { key: 'segment', label: '航段', children: selected.segmentId },
          { key: 'owner', label: '调查负责人', children: selected.owner },
          { key: 'due', label: '截止日期', children: selected.dueDate }
        ]} />
        <Form form={form} layout="vertical" className="deviation-form">
          <div className="two-column">
            <Form.Item name="cause" label="原因调查" rules={[{ required: true, message: '必须记录设备、操作、转运或环境因素' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭' && !selected.staleReason} /></Form.Item>
            <Form.Item name="assessment" label="影响评估" rules={[{ required: true, message: '必须评估超限时间与货物稳定性' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭' && !selected.staleReason} /></Form.Item>
          </div>
          <div className="two-column">
            <Form.Item name="disposition" label="建议处置" rules={[{ required: true }]}><Select disabled={selected.status === '已关闭' && !selected.staleReason} options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
            <Form.Item name="evidence" label="证据摘要" rules={[{ required: true }]}><Input disabled={selected.status === '已关闭' && !selected.staleReason} /></Form.Item>
          </div>
          <Form.Item name="evidenceIds" label="引用证据版本（换版后引用自动失效）" rules={[{ required: true, message: '调查结论必须引用至少一个现行证据版本' }]}>
            <Select mode="multiple" disabled={selected.status === '已关闭' && !selected.staleReason} options={evidenceOptions} placeholder="选择调查依据的证据文件版本" />
          </Form.Item>
          <Form.Item name="correctiveAction" label="纠正措施或收货条件" rules={[{ required: true }]}><Input.TextArea rows={3} disabled={selected.status === '已关闭' && !selected.staleReason} /></Form.Item>
        </Form>
        <Tabs items={[
          { key: 'point', label: '原始时间点', children: <div className="raw-points"><strong>温度点只读</strong><p>航段原始记录已关联至任务，任何调查修订不得覆盖设备原始曲线。</p><code>{shipment?.segments.find((item) => item.id === selected.segmentId)?.temperature.slice(0, 6).map((item) => `${item.time.slice(11, 16)} ${item.value}℃`).join('  |  ')}</code></div> },
          { key: 'refs', label: `结论引用 (${selected.evidenceRefs.length})`, children: selected.evidenceRefs.length ? <Table size="small" rowKey="evidenceId" pagination={false} dataSource={selected.evidenceRefs} columns={[
            { title: '证据', dataIndex: 'evidenceId' },
            { title: '分类', dataIndex: 'category' },
            { title: '引用的文件版本', dataIndex: 'evidenceVersion', render: (value: number) => `文件V${value}` },
            { title: '写入时统一版本', dataIndex: 'recordVersion', render: (value: number) => `V${value}` },
            { title: '引用状态', render: () => selected.staleReason ? <Tag color="error">已失效</Tag> : <Tag color="success">有效</Tag> }
          ]} /> : <Empty description="尚未引用证据版本" /> },
          {
            key: 'review', label: `复核记录 (${selected.reviewHistory.length})`, children: selected.reviewHistory.length ? <div className="review-history">{[...selected.reviewHistory].reverse().map((entry, index) => <Card key={index} size="small" className={entry.superseded ? 'review-superseded' : ''}>
              <div className="signature-head"><strong>{entry.reviewer}</strong><Space><Tag>{entry.disposition}</Tag><Tag color={entry.superseded ? 'warning' : 'success'}>{entry.superseded ? '已随证据换版失效' : '现行'}</Tag></Space></div>
              <p>{entry.reviewNote}</p><small>引用 {entry.evidenceVersion} · 统一V{entry.recordVersion} · {entry.reviewedAt.replace('T', ' ').slice(0, 16)}</small>
            </Card>)}</div> : selected.reviewer ? <Card size="small"><strong>{selected.reviewer}</strong><p>{selected.reviewNote}</p></Card> : <Empty description="尚未复核" />
          }
        ]} />
      </div>
    </div>
    <Modal title="放行复核" open={reviewOpen} onCancel={() => setReviewOpen(false)} onOk={review} okText="确认复核">
      <Alert className="modal-tip" type="info" showIcon message={`复核结论将锁定调查引用的证据版本（${selected.evidenceRefs.map((ref) => `${ref.category} V${ref.evidenceVersion}`).join('、') || '无'}）；证据再换版时该结论自动失效。`} />
      <Form form={form} layout="vertical">
        <Form.Item name="disposition" label="复核结论" rules={[{ required: true }]}><Select options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
        <Form.Item name="reviewNote" label="复核意见" rules={[{ required: true, message: '复核必须填写意见' }]}><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
  </section>
}
