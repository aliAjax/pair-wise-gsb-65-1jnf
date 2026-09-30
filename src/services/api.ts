import axios from 'axios'
import type { Shipment } from '../types'

const client = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api', timeout: 5000 })

export async function loadShipmentSnapshot(fallback: Shipment[]): Promise<Shipment[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try { return (await client.get<Shipment[]>('/shipments')).data } catch { return fallback }
}

export async function requestRelease(shipmentId: string, payload: { temperatureVerified: boolean; evidenceVerified: boolean }) {
  if (!import.meta.env.VITE_API_BASE_URL) return { accepted: true, requestId: `LOCAL-${shipmentId}` }
  return (await client.post(`/shipments/${shipmentId}/release`, payload)).data
}
