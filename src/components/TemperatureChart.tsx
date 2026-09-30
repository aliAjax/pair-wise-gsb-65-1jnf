import { useMemo, useState } from 'react'
import { Button } from 'antd'
import type { TemperaturePoint } from '../types'

interface Props {
  points: TemperaturePoint[]
  min: number
  max: number
}

export function TemperatureChart({ points, min, max }: Props) {
  const [zoom, setZoom] = useState(1)
  const geometry = useMemo(() => {
    const visible = points.slice(0, Math.max(4, Math.round(points.length * zoom)))
    const low = Math.min(min, ...visible.map((item) => item.value)) - 1
    const high = Math.max(max, ...visible.map((item) => item.value)) + 1
    const coordinates = visible.map((item, index) => ({
      ...item,
      x: 30 + (index / Math.max(visible.length - 1, 1)) * 520,
      y: 145 - ((item.value - low) / Math.max(high - low, 1)) * 100
    }))
    return { low, high, coordinates, path: coordinates.map((item, index) => `${index ? 'L' : 'M'} ${item.x} ${item.y}`).join(' ') }
  }, [points, min, max, zoom])

  return <div className="chart-wrap">
    <div className="chart-tools"><span>显示 {geometry.coordinates.length} 个原始时间点</span><Button size="small" onClick={() => setZoom((value) => Math.max(.45, value - .15))}>缩小</Button><Button size="small" onClick={() => setZoom((value) => Math.min(1, value + .15))}>放大</Button></div>
    <svg viewBox="0 0 580 180" role="img" aria-label="温度曲线">
      <rect x="30" y={145 - ((max - geometry.low) / (geometry.high - geometry.low)) * 100} width="520" height={((max - min) / (geometry.high - geometry.low)) * 100} fill="#edf7f3" />
      <line x1="30" y1="145" x2="550" y2="145" stroke="#83918e" />
      <line x1="30" y1="20" x2="30" y2="145" stroke="#83918e" />
      <text x="4" y="28" fontSize="10">{geometry.high.toFixed(1)}℃</text>
      <text x="4" y="149" fontSize="10">{geometry.low.toFixed(1)}℃</text>
      <text x="32" y="18" fontSize="10" fill="#7a8784">允许范围 {min}-{max}℃</text>
      <path d={geometry.path} fill="none" stroke="#146b74" strokeWidth="2.2" />
      {geometry.coordinates.map((item) => <g key={item.id}><circle cx={item.x} cy={item.y} r="3" fill={item.value < min || item.value > max ? '#bf3f39' : '#146b74'} /><title>{`${item.time.replace('T', ' ').slice(0, 16)}，${item.value}℃`}</title></g>)}
    </svg>
  </div>
}
