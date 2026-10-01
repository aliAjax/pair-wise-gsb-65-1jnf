import { Alert, Badge, Button, Space, Switch, Tag } from 'antd'
import { useShipmentStore } from '../store/useShipmentStore'

/** 故障注入 + 并发模拟：用于演示写入失败恢复与后到一方的冲突版本拦截 */
export function VersionOps({ shipmentId, expectedVersion }: { shipmentId?: string; expectedVersion?: number }) {
  const failNextWrite = useShipmentStore((state) => state.failNextWrite)
  const setFailNextWrite = useShipmentStore((state) => state.setFailNextWrite)
  const simulateRemoteChange = useShipmentStore((state) => state.simulateRemoteChange)
  return <Space className="version-ops" size={16} wrap>
    <span><Switch size="small" checked={failNextWrite} onChange={setFailNextWrite} /> <em>下一次写入失败（演示从最后完整版本恢复）</em></span>
    {shipmentId && <Button size="small" onClick={() => simulateRemoteChange(shipmentId)}>模拟另一窗口先保存 V{expectedVersion !== undefined ? expectedVersion + 1 : '?'}</Button>}
  </Space>
}

/** 全局未完成项：写入失败后从最后一个完整版本恢复，只补未完成项 */
export function PendingWriteBanner() {
  const pendingWrites = useShipmentStore((state) => state.pendingWrites)
  const retry = useShipmentStore((state) => state.retryPendingWrite)
  const discard = useShipmentStore((state) => state.discardPendingWrite)
  if (pendingWrites.length === 0) return null
  return <div className="pending-banner">
    {pendingWrites.map((item) => <Alert
      key={item.id}
      type="warning"
      showIcon
      message={<Space wrap>
        <Badge status="warning" />
        <strong>未完成写入</strong>
        <Tag>{item.shipmentId}</Tag>
        <span>基于 V{item.baseVersion}</span>
        <span>{item.label}</span>
        <span className="pending-time">失败于 {item.createdAt.replace('T', ' ').slice(5, 16)}</span>
      </Space>}
      description="状态已停在最后一个完整版本；可仅补写这一项，或放弃后基于最新版本重新处置。"
      action={<Space>
        <Button size="small" type="primary" onClick={() => retry(item.id)}>恢复补写</Button>
        <Button size="small" onClick={() => discard(item.id)}>放弃</Button>
      </Space>}
    />)}
  </div>
}
