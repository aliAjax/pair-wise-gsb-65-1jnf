import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Descriptions, Empty, Form, Input, Modal, Select, Space, Tabs, Tag, message } from 'antd'
import { isDeviationStale, referencedEvidence, useShipmentStore } from '../store/useShipmentStore'
import type { Deviation, RecordVersionEntry, SaveResult } from '../types'

export function DeviationWorkbench() {
  const state = useShipmentStore()
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const selected = state.deviations.find((item) => item.id === selectedId) ?? state.deviations[0]
  const shipment = selected ? state.shipments.find((item) => item.id === selected.shipmentId) : undefined
  /** 本窗口打开该偏差时看到的统一版本：保存时据此做乐观并发校验 */
  const [baseVersion, setBaseVersion] = useState(shipment?.version ?? 0)
  const [conflict, setConflict] = useState<{ message: string; latest: RecordVersionEntry } | null>(null)
  const [form] = Form.useForm()
  const [reviewOpen, setReviewOpen] = useState(false)

  useEffect(() => {
    if (selected) {
      form.setFieldsValue(selected)
      const s = state.shipments.find((item) => item.id === selected.shipmentId)
      setBaseVersion(s?.version ?? 0)
      setConflict(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])
  // 其它窗口写入后（跨标签同步）统一版本前进，本窗口若仍持有旧表单则提示冲突
  useEffect(() => {
    if (shipment && baseVersion && shipment.version !== baseVersion && !conflict) {
      const latest = shipment.recordLedger[shipment.recordLedger.length - 1]
      setConflict({ message: `另一窗口已将 ${shipment.id} 更新到 V${shipment.version}（${latest.title}），您正在编辑 V${baseVersion}。请基于最新版本重新处置，不能覆盖对方操作。`, latest })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipment?.version])

  const handle = (result: SaveResult, onOk?: () => void) => {
    if (result.ok) {
      message.success(result.message)
      setConflict(null)
      const s = state.shipments.find((item) => item.id === selected.shipmentId)
      if (s) setBaseVersion(s.version)
      onOk?.()
    } else if (result.conflict) {
      setConflict({ message: result.message, latest: result.conflict.latest })
      message.error('版本冲突：已阻止覆盖')
    } else {
      message.error(result.message)
    }
  }

  const save = async () => {
    const values = await form.validateFields()
    handle(state.saveInvestigation(selected.id, baseVersion, {
      cause: values.cause, assessment: values.assessment, disposition: values.disposition,
      correctiveAction: values.correctiveAction, evidence: values.evidence, evidenceRefs: values.evidenceRefs
    }), () => message.success(selected.stale ? '已基于最新证据重新复核' : '调查已提交放行复核'))
  }
  const review = async () => {
    const values = await form.validateFields(['disposition', 'reviewNote'])
    handle(state.reviewDeviation(selected.id, baseVersion, values.disposition, values.reviewNote), () => setReviewOpen(false))
  }

  if (!selected) return <section className="page"><Empty description="暂无偏差" /></section>

  const stale = isDeviationStale(selected, shipment)
  const evidenceOptions = shipment?.evidence.map((item) => ({
    label: `${item.category} V${item.version} · ${item.name}${item.superseded ? '（已替代，不可引用）' : item.verified ? '（已核验）' : '（待核验）'}`,
    value: item.id,
    disabled: item.superseded
  })) ?? []
  const refs = referencedEvidence(selected, shipment)

  return <section className="page">
    <header className="page-head"><div><p>温度超限 / 原因调查 / 放行复核</p><h1>温度偏差调查</h1></div><Badge count={state.deviations.filter((item) => item.status !== '已关闭').length} showZero /></header>
    {conflict && <Alert className="conflict-alert" type="error" showIcon message="统一版本冲突"
      description={<div>{conflict.message}<div className="conflict-actions"><Button size="small" type="primary" onClick={() => { setConflict(null); setBaseVersion(shipment?.version ?? 0); if (shipment) form.setFieldsValue(state.deviations.find((item) => item.id === selected.id)) }}>刷新到 V{shipment?.version} 重新编辑</Button></div></div>} />}
    <div className="deviation-layout">
      <div className="deviation-nav">{state.deviations.map((item) => {
        const s = state.shipments.find((ship) => ship.id === item.shipmentId)
        return <button key={item.id} className={item.id === selected.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
          <div><Badge status={item.severity === '重大' ? 'error' : 'warning'} /><strong>{item.title}</strong></div>
          <span>{item.id}</span>
          <small>{item.shipmentId} · 统一V{s?.version ?? '—'}</small>
          <Space size={4} wrap>
            <Tag color={item.status === '已关闭' ? 'success' : 'processing'}>{item.status}</Tag>
            {isDeviationStale(item, s) && <Tag color="error">结论失效</Tag>}
          </Space>
        </button>
      })}</div>
      <div className="deviation-main">
        <div className="panel-title"><div><h2>{selected.title}</h2><span>{selected.id} · {selected.source}</span></div><Space>
          <Button onClick={() => setReviewOpen(true)} disabled={selected.status !== '待放行复核' || stale}>放行复核</Button>
          <Button type="primary" onClick={save} disabled={selected.status === '已关闭'}>{stale ? '重新复核并提交' : '保存并提交'}</Button>
        </Space></div>
        {stale && <Alert className="conflict-alert" type="error" showIcon
          message="引用的证据版本已被替代，本调查结论失效"
          description="请在下方改选最新证据版本，重新确认原因与评估后提交；放行签署已随证据换版撤回（原意见保留），待重新复核后再放行。" />}
        <Descriptions size="small" column={4} items={[
          { key: 'shipment', label: '运输任务 / 统一版本', children: <Space size={4}>{selected.shipmentId}<Tag color="blue">V{shipment?.version}</Tag></Space> },
          { key: 'segment', label: '航段', children: selected.segmentId },
          { key: 'owner', label: '调查负责人', children: selected.owner },
          { key: 'based', label: '结论基于版本', children: <Space size={4}><Tag>单据V{selected.version}</Tag><Tag color={stale ? 'red' : 'geekblue'}>统一V{selected.recordVersion}</Tag>{stale && <Tag color="error">已落后</Tag>}</Space> }
        ]} />
        <Form form={form} layout="vertical" className="deviation-form" initialValues={selected}>
          <Form.Item name="evidenceRefs" label="引用证据版本（换版后须改选最新版本）" rules={[{ required: true, message: '调查结论必须引用至少一个证据版本' }]}>
            <Select mode="multiple" options={evidenceOptions} placeholder="选择温度曲线/设备报告等证据版本" />
          </Form.Item>
          {refs.length > 0 && <div className="ref-evidence">
            {refs.map((item) => <Tag key={item.id} color={item.superseded ? 'error' : item.verified ? 'success' : 'warning'}>
              {item.category} V{item.version}{item.superseded ? '（已替代）' : ''}
            </Tag>)}
          </div>}
          <div className="two-column">
            <Form.Item name="cause" label="原因调查" rules={[{ required: true, message: '必须记录设备、操作、转运或环境因素' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭'} /></Form.Item>
            <Form.Item name="assessment" label="影响评估" rules={[{ required: true, message: '必须评估超限时间与货物稳定性' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭'} /></Form.Item>
          </div>
          <div className="two-column">
            <Form.Item name="disposition" label="建议处置" rules={[{ required: true }]}><Select disabled={selected.status === '已关闭'} options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
            <Form.Item name="evidence" label="证据摘要" rules={[{ required: true }]}><Input disabled={selected.status === '已关闭'} /></Form.Item>
          </div>
          <Form.Item name="correctiveAction" label="纠正措施或收货条件" rules={[{ required: true }]}><Input.TextArea rows={3} disabled={selected.status === '已关闭'} /></Form.Item>
        </Form>
        <Tabs items={[{
          key: 'point', label: '原始时间点', children: <div className="raw-points"><strong>温度点只读</strong><p>航段原始记录已关联至任务，任何调查修订不得覆盖设备原始曲线。</p><code>{shipment?.segments.find((item) => item.id === selected.segmentId)?.temperature.slice(0, 6).map((item) => `${item.time.slice(11, 16)} ${item.value}℃`).join('  |  ')}</code></div>
        }, {
          key: 'review', label: '复核记录', children: selected.reviewer ? <Card size="small"><strong>{selected.reviewer}</strong><p>{selected.reviewNote}</p></Card> : <Empty description="尚未复核" />
        }]} />
      </div>
    </div>
    <Modal title="放行复核" open={reviewOpen} onCancel={() => setReviewOpen(false)} onOk={review} okText="确认复核">
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`基于统一版本 V${shipment?.version} 复核，另一窗口若已换版将拦截本次保存`} />
      <Form form={form} layout="vertical">
        <Form.Item name="disposition" label="复核结论" rules={[{ required: true }]}><Select options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
        <Form.Item name="reviewNote" label="复核意见" rules={[{ required: true, message: '复核必须填写意见' }]}><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
  </section>
}
