const BASE = '/api';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || res.statusText;
    throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
  }
  return data;
}

export const api = {
  // certs
  listCerts: () => req('GET', '/certs'),
  createCert: (body) => req('POST', '/certs', body),
  revokeCert: (id) => req('POST', `/certs/${id}/revoke`),
  // nodes
  listNodes: () => req('GET', '/nodes'),
  createNode: (body) => req('POST', '/nodes', body),
  nodeDetail: (id) => req('GET', `/nodes/${id}`),
  // releases
  listReleases: () => req('GET', '/releases'),
  createRelease: (body) => req('POST', '/releases', body),
  releaseDetail: (id) => req('GET', `/releases/${id}`),
  startRelease: (id, operator) => req('POST', `/releases/${id}/start`, { operator }),
  takeoverPreview: (id) => req('GET', `/releases/${id}/takeover-preview`),
  confirmTakeover: (id, operator) => req('POST', `/releases/${id}/takeover`, { operator }),
  promote: (id) => req('POST', `/releases/${id}/promote`),
  pause: (id) => req('POST', `/releases/${id}/pause`),
  resume: (id) => req('POST', `/releases/${id}/resume`),
  retry: (id) => req('POST', `/releases/${id}/retry`),
  rollback: (id, operator) => req('POST', `/releases/${id}/rollback`, { operator }),
  cancel: (id, reason) => req('POST', `/releases/${id}/cancel`, { reason }),
  // receipts
  listReceipts: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return req('GET', `/receipts${qs ? `?${qs}` : ''}`);
  },
};

export const RELEASE_STATUS = {
  draft: '草稿',
  running: '执行中',
  gate_paused: '灰度门暂停',
  paused: '已暂停',
  failed: '有节点失败',
  completed: '已完成',
  rolling_back: '回滚中',
  rolled_back: '已回滚',
  cancelled: '已取消',
  superseded: '已被接管',
};

export const TASK_STATUS = {
  pending: '待下发',
  in_flight: '执行中',
  success: '成功',
  failed: '失败',
  superseded: '被替代',
  cancelled: '已取消',
  restoring: '恢复中',
  rolled_back: '已回退',
  adopted: '已沿用',
};

export function fmtTime(t) {
  if (!t) return '-';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}
