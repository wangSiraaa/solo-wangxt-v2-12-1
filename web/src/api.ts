export interface Snapshot {
  nodes: any[];
  events: any[];
  lateReceipts: any[];
  releases: any[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body}`);
  }
  return response.json();
}

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  reset: () => request<void>('/api/demo/reset', { method: 'POST' }),
  behavior: (nodeId: string, behavior: string) =>
    request<Snapshot>(`/api/nodes/${nodeId}/behavior`, { method: 'PUT', body: JSON.stringify({ behavior }) }),
  normal: (payload: unknown) => request('/api/releases/normal', { method: 'POST', body: JSON.stringify(payload) }),
  preview: (payload: unknown) => request('/api/releases/emergency/preview', { method: 'POST', body: JSON.stringify(payload) }),
  confirm: (payload: unknown) => request('/api/releases/emergency/confirm', { method: 'POST', body: JSON.stringify(payload) }),
  release: (id: string) => request(`/api/releases/${id}`),
  approve: (id: string) => request(`/api/releases/${id}/canary/approve`, { method: 'POST' }),
  retry: (id: string) => request(`/api/releases/${id}/retry`, { method: 'POST' }),
  rollback: (id: string) => request(`/api/releases/${id}/rollback`, { method: 'POST' }),
  cancelEmergency: (id: string) => request(`/api/releases/${id}/cancel-emergency`, { method: 'POST' }),
};
