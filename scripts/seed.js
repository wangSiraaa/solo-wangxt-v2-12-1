'use strict';
/**
 * Seed the platform with demo data via the public API.
 * Usage: API=http://127.0.0.1:3000/api SIM=http://127.0.0.1:4100 node scripts/seed.js
 */
const API = process.env.API || 'http://127.0.0.1:3000/api';
const SIM = process.env.SIM || 'http://127.0.0.1:4100';

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const domain = 'api.example.com';
  const now = Date.now();
  const v1 = await req('POST', `${API}/certs`, {
    domain, version: 1, content: `cert-${domain}-v1`,
    notBefore: new Date(now - 86400_000).toISOString(),
    notAfter: new Date(now + 30 * 86400_000).toISOString(),
  });
  const v2 = await req('POST', `${API}/certs`, {
    domain, version: 2, content: `cert-${domain}-v2`,
    notBefore: new Date(now - 3600_000).toISOString(),
    notAfter: new Date(now + 30 * 86400_000).toISOString(),
  });
  const v3 = await req('POST', `${API}/certs`, {
    domain, version: 3, content: `cert-${domain}-v3-emergency`,
    notBefore: new Date(now - 600_000).toISOString(),
    notAfter: new Date(now + 7 * 86400_000).toISOString(),
  });

  const nodes = [];
  for (let i = 1; i <= 5; i++) {
    const node = await req('POST', `${API}/nodes`, {
      name: `node-${i}`,
      domains: [domain],
      currentCertId: v1.id,
      currentCertVersion: 1,
    });
    await req('POST', `${SIM}/admin/nodes`, { nodeId: node.id, certId: v1.id, version: 1 });
    nodes.push(node);
  }

  // a normal release stuck at the gray gate makes the demo interesting
  const normal = await req('POST', `${API}/releases`, {
    name: '常规轮换-v2',
    kind: 'normal',
    certId: v2.id,
    nodeIds: nodes.map((n) => n.id),
    strategy: { canaryPercent: 20, batchSize: 2, dispatchTimeoutMs: 3000, maxAttempts: 3 },
    createdBy: 'seed',
  });
  await req('POST', `${API}/releases/${normal.id}/start`, { operator: 'seed' });

  // an emergency release, drafted and ready for takeover confirmation
  await req('POST', `${API}/releases`, {
    name: '紧急证书-v3（待接管确认）',
    kind: 'emergency',
    certId: v3.id,
    nodeIds: nodes.map((n) => n.id),
    strategy: { dispatchTimeoutMs: 3000, maxAttempts: 3 },
    createdBy: 'seed',
  });

  console.log('seeded:');
  console.log(`  certs: v1=${v1.id} v2=${v2.id} v3=${v3.id}`);
  console.log(`  nodes: ${nodes.map((n) => n.id).join(', ')}`);
  console.log(`  normal release (running, will hit the gray gate): ${normal.id}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
