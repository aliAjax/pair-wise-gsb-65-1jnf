import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, Descriptions, Divider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Timeline, Tooltip, message } from 'antd'
import { ThunderboltOutlined, UploadOutlined } from '@ant-design/icons'
import { TemperatureChart } from '../components/TemperatureChart'
import { useShipmentStore } from '../store/useShipmentStore'
import { SESSION_ID } from '../services/session'
import type { EvidenceFile, RecordVersionEntry, ShipmentSignature } from '../types'
import { versionKindColor } from '../types'

const fmt = (iso: string) => iso ? iso.replace('T', ' ').slice(0, 16) : ''

export function ShipmentDetail() {
  const { id } = useParams()
  const state = useShipmentStore()
  const shipment = state.shipments.find((item) => item.id === id)
  const [activeSegmentId, setActiveSegmentId] = useState(shipment?.segments[0]?.id ?? '')
  const [signOpen, setSignOpen] = useState(false)
  const [deviationOpen, setDeviationOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [correctOpen, setCorrectOpen] = useState(false)
  const [conflict, setConflict] = useState<{ message: string; latest: RecordVersionEntry } | null>(null)
  /** 本窗口打开编辑/放行时所看到的统一版本，保存时据此做乐观并发校验 */
  const [baseVersion, setBaseVersion] = useState(shipment?.version ?? 0)
  const [signForm] = Form.useForm()
  const [devForm] = Form.useForm()
  const [uploadForm] = Form.useForm()
  const [correctForm] = Form.useForm()

  if (!shipment) return <section className="page empty">未找到运输任务</section>
  const activeSegment = shipment.segments.find((item) => item.id === activeSegmentId) ?? shipment.segments[0]
  const deviations = state.deviations.filter((item) => item.shipmentId === shipment.id)
  const openDeviations = deviations.filter((item) => item.status !== '已关闭')
  const staleDeviations = deviations.filter((item) => item.stale)
  const withdrawnSignatures = shipment.signatures.filter((item) => item.status === '已撤回')
  const recoveryPlan = state.recoveryPlans.find((plan) => plan.shipmentId === shipment.id)
  const released = shipment.status === '已放行'

  const handle = (result: ReturnType<typeof state.sign>, onOk?: () => void) => {
    if (result.ok) {
      message.success(result.message)
      setConflict(null)
      setBaseVersion(useShipmentStore.getState().shipments.find((item) => item.id === shipment.id)?.version ?? shipment.version)
      onOk?.()
    } else if (result.conflict) {
      setConflict({ message: result.message, latest: result.conflict.latest })
      message.error('检测到版本冲突，已阻止覆盖')
    } else {
      message.error(result.message)
    }
  }

  const evidenceColumns = [
    { title: '文件', dataIndex: 'name', render: (value: string, row: EvidenceFile) => <div><strong>{value}</strong><small className="cell-sub">{row.category} · V{row.version}{row.superseded ? ' · 已被替代' : ''}</small></div> },
    { title: '状态', width: 110, render: (_: unknown, row: EvidenceFile) => <Space size={4} wrap>{row.superseded ? <Tag color="default">已替代</Tag> : row.verified ? <Tag color="success">已核验</Tag> : <Tag color="warning">待核验</Tag>}</Space> },
    { title: '上传', render: (_: unknown, row: EvidenceFile) => `${row.uploadedBy} ${fmt(row.uploadedAt)}` },
    { title: '核验', dataIndex: 'verified', width: 95, render: (value: boolean, row: EvidenceFile) => value || row.superseded ? <span className="muted">—</span> : <Button size="small" onClick={() => handle(state.verifyEvidence(shipment.id, shipment.version, row.id))}>核验</Button> }  ]

  const captureBase = () => { setBaseVersion(shipment.version); setConflict(null) }

  const submitSign = async () => {
    const values = await signForm.validateFields()
    handle(state.sign(shipment.id, baseVersion, values.role, values.comment ?? '', values.decision), () => setSignOpen(false))
  }
  const submitDeviation = async () => {
    const values = await devForm.validateFields()
    handle(state.createDeviation(shipment.id, baseVersion, values.segmentId, values.title, values.severity), () => setDeviationOpen(false))
  }
  const submitUpload = async () => {
    const values = await uploadForm.validateFields()
    handle(state.addEvidence(shipment.id, baseVersion, { name: values.name, category: values.category, uploadedBy: '当前用户' }), () => { setUploadOpen(false); uploadForm.resetFields() })
  }
  const submitCorrect = async () => {
    const values = await correctForm.validateFields()
    handle(state.addEvidence(shipment.id, baseVersion, { name: values.name, category: values.category, uploadedBy: '当前用户', reason: values.reason }), () => { setCorrectOpen(false); correctForm.resetFields() })
  }
  const release = () => handle(state.setShipmentStatus(shipment.id, baseVersion, '已放行'))

  const categoryOptions = ['温度曲线', '设备报告', '包装确认', '交接签字'].map((value) => ({ label: value, value }))

  return <section className="page">
    <header className="page-head detail-head">
      <div><p>{shipment.id} · {shipment.batch} · 本窗口 {SESSION_ID}</p><h1>{shipment.product}</h1></div>
      <Space>
        <Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag>
        <Tooltip title="演示：注入一次写入失败，自动回滚并生成从最后完整版本恢复的计划">
          <Button icon={<ThunderboltOutlined />} onClick={() => { state.armFailure(shipment.id); message.warning('已注入下一次写入失败（仅本窗口生效）') }}>模拟写入失败</Button>
        </Tooltip>
        <Button onClick={() => { captureBase(); setDeviationOpen(true) }}>登记偏差</Button>
        <Button onClick={() => { captureBase(); setSignOpen(true) }}>角色签收</Button>
        {released
          ? <Button onClick={() => { captureBase(); setCorrectOpen(true) }}>放行后更正</Button>
          : <Button type="primary" icon={<UploadOutlined />} onClick={() => { captureBase(); setUploadOpen(true) }}>常补证据/换设备</Button>}
        <Button type="primary" onClick={release} disabled={released}>放行审核</Button>
      </Space>
    </header>

    {conflict && <Alert className="conflict-alert" type="error" showIcon
      message="版本冲突：后到一方不能覆盖对方处置"
      description={<div>{conflict.message}<div className="conflict-actions"><Button size="small" type="primary" onClick={() => { setConflict(null); setBaseVersion(shipment.version) }}>我已知悉，基于当前V{shipment.version}重新处置</Button></div></div>} />}

    {recoveryPlan && <Alert className="conflict-alert" type="error" showIcon message={`写入失败，当前仍停留在最后完整版本 V${shipment.version}`}
      description={<Space wrap>
        {recoveryPlan.steps.map((step, index) => <Tag key={index} color={step.state === '已完成' ? 'default' : 'red'}>{step.state === '已完成' ? '已完成·恢复时重放' : '未完成·待补录'}：{step.label}</Tag>)}
        <Button size="small" type="primary" onClick={() => handle(state.resumeRecovery(shipment.id, shipment.version))}>恢复并重放/补录</Button>
        <Button size="small" onClick={() => state.discardRecovery(shipment.id)}>放弃恢复</Button>
      </Space>} />}

    {staleDeviations.length > 0 && <Alert type="warning" showIcon message={`${staleDeviations.length}项偏差引用的证据版本已失效`} description="换版后旧调查结论不再有效，须到偏差工作台基于最新证据重新复核；放行签署已撤回但原意见保留。" />}
    {openDeviations.length > 0 && <Alert type="error" showIcon message={`存在${openDeviations.length}项未关闭温度偏差，系统阻止放行`} />}

    <Descriptions className="summary-band" size="small" column={5} items={[
      { key: 'route', label: '运输路线', children: shipment.route },
      { key: 'box', label: '温控箱', children: shipment.containerId },
      { key: 'range', label: '允许范围', children: `${shipment.tempMin} - ${shipment.tempMax} ℃` },
      { key: 'version', label: '统一版本', children: <Space size={4}><Tag color="blue">V{shipment.version}</Tag>{released && <Tag color="success">放行锚定V{shipment.releasedAtVersion}</Tag>}</Space> },
      { key: 'updated', label: '最近更新', children: fmt(shipment.updatedAt) }
    ]} />
    <div className="detail-grid">
      <div className="timeline-panel">
        <div className="panel-title"><h2>航段时间轴</h2><span>原始温度点不可修改</span></div>
        {shipment.segments.map((segment) => <button key={segment.id} className={activeSegment.id === segment.id ? 'active' : ''} onClick={() => setActiveSegmentId(segment.id)}>
          <div className="segment-index">{segment.id.replace('SEG-', '')}</div>
          <div><strong>{segment.from} → {segment.to}</strong><span>{segment.flight} · {fmt(segment.plannedStart)}</span><small>操作人：{segment.handler} · {segment.note}</small></div>
          <Badge status={segment.temperature.some((item) => item.value < shipment.tempMin || item.value > shipment.tempMax) ? 'error' : 'success'} />
        </button>)}
      </div>
      <div className="chart-panel">
        <div className="panel-title"><h2>{activeSegment.from} → {activeSegment.to}</h2><span>{activeSegment.flight}</span></div>
        <TemperatureChart points={activeSegment.temperature} min={shipment.tempMin} max={shipment.tempMax} />
        <div className="segment-meta"><span>计划：{fmt(activeSegment.plannedStart)}</span><span>实际：{fmt(activeSegment.actualStart)} - {fmt(activeSegment.actualEnd)}</span></div>
      </div>
    </div>
    <Tabs className="detail-tabs" items={[
      {
        key: 'evidence', label: `证据版本 (${shipment.evidence.length})`, children: <div>
          <div className="tab-actions">
            <Space>{released
              ? <Button icon={<UploadOutlined />} onClick={() => { captureBase(); setCorrectOpen(true) }}>放行后更正（另存原因版本）</Button>
              : <Button type="primary" icon={<UploadOutlined />} onClick={() => { captureBase(); setUploadOpen(true) }}>常补证据 / 换设备报告</Button>}
              <span>同分类新版本替代旧版本，引用旧版本的调查结论立即失效，放行签署联动撤回</span>
            </Space>
          </div>
          <Table rowKey="id" size="small" columns={evidenceColumns} dataSource={shipment.evidence} pagination={false} />
        </div>
      },
      {
        key: 'signatures', label: `签收记录 (${shipment.signatures.filter((item) => item.status === '已签').length}/${shipment.signatures.length})`,
        children: <div className="signature-grid">{shipment.signatures.map((item) => <SignatureCard key={item.role} signature={item} />)}</div>
      },
      {
        key: 'deviations', label: `偏差 (${deviations.length})`, children: <Table rowKey="id" size="small" pagination={false} dataSource={deviations} columns={[
          { title: '编号', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' },
          { title: '状态', dataIndex: 'status', render: (value: string, row) => <Space size={4}><Tag>{value}</Tag>{row.stale && <Tag color="error">结论失效·待复核</Tag>}</Space> },
          { title: '修订/统一版本', render: (_: unknown, row) => `单V${row.version} / 统一V${row.recordVersion}` }
        ]} />
      },
      { key: 'ledger', label: `版本记录 (${shipment.recordLedger.length})`, children: <LedgerTimeline entries={shipment.recordLedger} /> }
    ]} />

    <Modal title="常补证据 / 换设备报告" open={uploadOpen} onCancel={() => setUploadOpen(false)} onOk={submitUpload} okText="提交换版">
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`当前统一版本 V${shipment.version}，保存时将基于该版本做冲突校验`} description="同分类旧版本被替代后，引用它的偏差结论失效、需重新复核，已完成的放行签署同步撤回（原意见保留在签署历史中）。" />
      <Form form={uploadForm} layout="vertical" initialValues={{ category: '设备报告', name: `换设备报告-${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '')}.pdf` }}>
        <Form.Item name="category" label="证据分类" rules={[{ required: true }]}><Select options={categoryOptions} /></Form.Item>
        <Form.Item name="name" label="文件名" rules={[{ required: true }]}><Input placeholder="例如：RKN更换设备后的校准报告.pdf" /></Form.Item>
      </Form>
    </Modal>

    <Modal title="放行后更正（原因版本）" open={correctOpen} onCancel={() => setCorrectOpen(false)} onOk={submitCorrect} okText="另存原因版本">
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`放行决定锚定 V${shipment.releasedAtVersion}，更正不会撤回或覆盖原放行`} description="更正作为带原因的新版本追加到统一版本线；受影响偏差仍需重新复核。" />
      <Form form={correctForm} layout="vertical" initialValues={{ category: '设备报告' }}>
        <Form.Item name="category" label="证据分类" rules={[{ required: true }]}><Select options={categoryOptions} /></Form.Item>
        <Form.Item name="name" label="更正文件名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="reason" label="更正原因" rules={[{ required: true, message: '放行后更正必须填写原因' }]}><Input.TextArea rows={3} placeholder="例如：客户复检发现设备校准证书版本有误，补充校准后报告" /></Form.Item>
      </Form>
    </Modal>

    <Modal title="多角色签收" open={signOpen} onCancel={() => setSignOpen(false)} onOk={submitSign} okText="提交签收">
      {withdrawnSignatures.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${withdrawnSignatures.map((item) => item.role).join('、')}的签署因证据换版已撤回，请重新签署`} />}
      <Form form={signForm} layout="vertical" initialValues={{ role: '放行人员', decision: '已签' }}>
        <Form.Item name="role" label="签收角色" rules={[{ required: true }]}><Select options={shipment.signatures.map((item) => ({ label: `${item.role}（${item.status}）`, value: item.role }))} /></Form.Item>
        <Form.Item name="decision" label="签收决定" rules={[{ required: true }]}><Select options={[{ label: '签署确认', value: '已签' }, { label: '退回补充', value: '已退回' }]} /></Form.Item>
        <Form.Item name="comment" label="签收意见"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>

    <Modal title="登记温度偏差" open={deviationOpen} onCancel={() => setDeviationOpen(false)} onOk={submitDeviation} okText="创建偏差">
      <Form form={devForm} layout="vertical" initialValues={{ segmentId: activeSegment.id, severity: '一般' }}>
        <Form.Item name="segmentId" label="发生航段" rules={[{ required: true }]}><Select options={shipment.segments.map((item) => ({ label: `${item.from} → ${item.to}`, value: item.id }))} /></Form.Item>
        <Form.Item name="title" label="偏差描述" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
        <Form.Item name="severity" label="严重度" rules={[{ required: true }]}><Select options={['一般', '重大'].map((value) => ({ label: value, value }))} /></Form.Item>
      </Form>
    </Modal>
  </section>
}

function SignatureCard({ signature }: { signature: ShipmentSignature }) {
  return <Card size="small">
    <div className="signature-head"><strong>{signature.role}</strong><Tag color={signature.status === '已签' ? 'success' : signature.status === '已退回' ? 'error' : signature.status === '已撤回' ? 'orange' : 'default'}>{signature.status}</Tag></div>
    <p>{signature.name}</p>
    <small>{signature.signedAt ? fmt(signature.signedAt) : signature.status === '已撤回' ? '签署已撤回（证据换版联动）' : '尚未签署'}</small>
    <Divider />
    <span>{signature.comment || '暂无意见'}</span>
    {signature.history.length > 0 && <div className="sig-history">
      <Divider style={{ margin: '8px 0' }} /><small className="muted">原意见保留（{signature.history.length}条）</small>
      {signature.history.slice().reverse().map((item, index) => <div key={index} className="sig-history-item">
        <Tag color={item.status === '已撤回' ? 'orange' : item.status === '已退回' ? 'error' : 'default'}>{item.status}</Tag>
        <small>{item.atVersion ? `V${item.atVersion}` : ''} · {fmt(item.signedAt)} · {item.comment || '无意见'}{item.reason ? ` · ${item.reason}` : ''}</small>
      </div>)}
    </div>}
  </Card>
}

function LedgerTimeline({ entries }: { entries: RecordVersionEntry[] }) {
  return <Timeline className="ledger" items={entries.slice().reverse().map((entry) => ({
    color: entry.kind === '放行后更正' ? 'magenta' : entry.kind === '故障恢复' ? 'red' : 'blue',
    children: <div className="ledger-item">
      <div className="ledger-head"><Tag color={versionKindColor[entry.kind]}>{entry.kind}</Tag><strong>V{entry.version} {entry.title}</strong><span>{fmt(entry.at)} · {entry.operator}{entry.sessionId ? ` · ${entry.sessionId}` : ''}</span></div>
      <p>{entry.detail}{entry.reason ? <span className="ledger-reason">更正原因：{entry.reason}</span> : null}</p>
      {entry.evidence && <small className="muted">证据：{entry.evidence.category} V{entry.evidence.version} {entry.evidence.name}</small>}
      {entry.affectedDeviations?.length ? <div>{entry.affectedDeviations.map((item) => <Tag key={item.id} color={item.invalidate ? 'error' : 'warning'}>{item.invalidate ? '结论失效' : '关联'}：{item.id}</Tag>)}</div> : null}
      {entry.withdrawnSignatures?.length ? <div>{entry.withdrawnSignatures.map((item) => <Tag key={item.role} color="orange">撤回签署：{item.role}（原V{item.atVersion}意见已保留）</Tag>)}</div> : null}
      {entry.recovered && <div className="recovered-box"><small>故障恢复：重放 [{entry.recovered.replayed.join('；') || '无'}]；补录 [{entry.recovered.supplemented.join('；') || '无'}]</small></div>}
    </div>
  }))} />
}
