'use strict';
/**
 * Managed-node simulator.
 *
 * Simulates fleet nodes that receive certificate push requests from the
 * release platform and asynchronously call back with a receipt.
 *
 * Behaviours per node (POST /admin/behavior):
 *   mode: 'auto'  -> complete with success after latencyMs
 *   mode: 'fail'  -> complete with failure after latencyMs
 *   mode: 'hold'  -> never complete until POST /admin/flush
 *
 * The simulator owns the *physical* cert state of each node. It applies the
 * pushed cert at completion time and then POSTs the receipt to callbackUrl.
 * If the callback cannot be delivered (platform down), the receipt is queued
 * and retried on the next /admin/flush.
 */
const http = require('http');

function createSimulator() {
  /** physical cert state: nodeId -> { certId, version } */
  const nodes = new Map();
  /** nodeId -> { mode: 'auto'|'fail'|'hold', latencyMs } */
  const behaviors = new Map();
  /** requestId -> dispatch record */
  const requests = new Map();
  /** ordered log of every dispatch received (for assertions/audit) */
  const dispatchLog = [];
  /** receipts that could not be delivered */
  const undelivered = [];

  function behaviorOf(nodeId) {
    return behaviors.get(nodeId) || { mode: 'auto', latencyMs: 50 };
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`callback ${url} -> ${res.status}`);
    return res;
  }

  async function deliverReceipt(req, receipt) {
    const payload = { requestId: req.requestId, ...receipt };
    try {
      await postJson(req.callbackUrl, payload);
      req.receiptDelivered = true;
    } catch (err) {
      req.receiptDelivered = false;
      undelivered.push({ req, payload });
    }
  }

  function complete(req, outcome, error) {
    if (req.status !== 'pending') return;
    req.status = 'done';
    req.completedAt = new Date().toISOString();
    if (outcome === 'success') {
      // physical node applies the cert
      nodes.set(req.nodeId, { certId: req.certId, version: req.certVersion });
      deliverReceipt(req, { outcome: 'success', certVersion: req.certVersion });
    } else {
      deliverReceipt(req, { outcome: 'failure', error: error || 'simulated node failure' });
    }
  }

  function handleDispatch(body) {
    const req = {
      requestId: body.requestId,
      nodeId: body.nodeId,
      certId: body.certId,
      certVersion: body.certVersion,
      callbackUrl: body.callbackUrl,
      status: 'pending',
      receivedAt: new Date().toISOString(),
    };
    requests.set(req.requestId, req);
    dispatchLog.push({ ...req });
    if (!nodes.has(req.nodeId)) nodes.set(req.nodeId, { certId: null, version: null });
    const b = behaviorOf(req.nodeId);
    if (b.mode === 'hold') return req;
    const outcome = b.mode === 'fail' ? 'failure' : 'success';
    setTimeout(() => complete(req, outcome), b.latencyMs ?? 50);
    return req;
  }

  async function flush(nodeId) {
    const flushed = [];
    for (const req of requests.values()) {
      if (req.status === 'pending' && (!nodeId || req.nodeId === nodeId)) {
        complete(req, 'success');
        flushed.push(req.requestId);
      }
    }
    // retry undelivered receipts
    for (let i = undelivered.length - 1; i >= 0; i--) {
      const { req, payload } = undelivered[i];
      try {
        await postJson(req.callbackUrl, payload);
        req.receiptDelivered = true;
        undelivered.splice(i, 1);
      } catch (_) { /* still down */ }
    }
    return flushed;
  }

  const routes = {
    'GET /health': async () => ({ ok: true }),
    'GET /admin/state': async () => ({
      nodes: Object.fromEntries(nodes),
      behaviors: Object.fromEntries(behaviors),
      requests: [...requests.values()],
      undelivered: undelivered.length,
    }),
    'GET /admin/requests': async (_body, query) => {
      const nodeId = query.get('nodeId');
      return dispatchLog.filter((r) => !nodeId || r.nodeId === nodeId);
    },
    'POST /admin/reset': async () => {
      nodes.clear(); behaviors.clear(); requests.clear();
      dispatchLog.length = 0; undelivered.length = 0;
      return { ok: true };
    },
    'POST /admin/nodes': async (body) => {
      // register/initialise physical node state
      for (const n of body.nodes || [body]) {
        nodes.set(n.nodeId, { certId: n.certId ?? null, version: n.version ?? null });
      }
      return { ok: true };
    },
    'POST /admin/behavior': async (body) => {
      behaviors.set(body.nodeId, { mode: body.mode || 'auto', latencyMs: body.latencyMs ?? 50 });
      return { ok: true };
    },
    'POST /admin/flush': async (body) => ({ flushed: await flush(body && body.nodeId) }),
    'POST /dispatch': async (body) => {
      if (!body.requestId || !body.nodeId || !body.callbackUrl) {
        throw Object.assign(new Error('requestId, nodeId and callbackUrl are required'), { statusCode: 400 });
      }
      const req = handleDispatch(body);
      return { accepted: true, requestId: req.requestId };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const result = await handler(body, url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return {
    server,
    state: { nodes, behaviors, requests, dispatchLog, undelivered },
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4100);
  const sim = createSimulator();
  sim.listen(port).then((p) => console.log(`[simulator] listening on ${p}`));
}

module.exports = { createSimulator };
