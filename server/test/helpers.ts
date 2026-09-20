import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { RuntimeConfig } from '../src/runtime-config';

const { createSimulator } = require('../../simulator');

const STATE_FILE = path.join(os.tmpdir(), 'cert-platform-e2e-pg.json');

export interface TestContext {
  app: INestApplication;
  api: string;
  sim: any;
  simUrl: string;
  dbUrl: string;
}

export async function createTestDb(): Promise<string> {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const dbName = 't_' + Math.random().toString(36).slice(2, 12);
  const { Client } = require('pg');
  const client = new Client({
    host: '127.0.0.1',
    port: state.port,
    user: state.user,
    password: state.password,
    database: 'postgres',
  });
  await client.connect();
  await client.query(`CREATE DATABASE ${dbName}`);
  await client.end();
  return `postgres://${state.user}:${state.password}@127.0.0.1:${state.port}/${dbName}`;
}

export async function startSimulator(): Promise<{ sim: any; simUrl: string }> {
  const sim = createSimulator();
  const port = await sim.listen(0);
  return { sim, simUrl: `http://127.0.0.1:${port}` };
}

export async function startApp(
  dbUrl: string,
  simUrl: string,
  port = 0,
): Promise<{ app: INestApplication; api: string; port: number }> {
  process.env.DATABASE_URL = dbUrl;
  process.env.SIMULATOR_URL = simUrl;
  process.env.SWEEP_INTERVAL_MS = '50';
  delete process.env.DISABLE_RECOVERY;
  const actualPort = port || (await getFreePort());
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  // the callback base url must be known before bootstrap: restart recovery
  // re-dispatches unfinished tasks during app.init()
  app.get(RuntimeConfig).publicBaseUrl = `http://127.0.0.1:${actualPort}`;
  await app.init();
  await app.listen(actualPort, '127.0.0.1');
  return { app, api: `http://127.0.0.1:${actualPort}/api`, port: actualPort };
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

export async function boot(): Promise<TestContext> {
  const dbUrl = await createTestDb();
  const { sim, simUrl } = await startSimulator();
  const { app, api } = await startApp(dbUrl, simUrl);
  return { app, api, sim, simUrl, dbUrl };
}

export async function bootOnPort(port: number): Promise<TestContext> {
  const dbUrl = await createTestDb();
  const { sim, simUrl } = await startSimulator();
  const { app, api } = await startApp(dbUrl, simUrl, port);
  return { app, api, sim, simUrl, dbUrl };
}

// ---------- HTTP helpers ----------

export async function req(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

export const get = (url: string) => req('GET', url);
export const post = (url: string, body?: any) => req('POST', url, body ?? {});

export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  label: string,
  timeoutMs = 15000,
): Promise<T> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(40);
  }
  throw new Error(`waitFor timed out: ${label}; last=${JSON.stringify(last)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture helpers ----------

export async function createCert(api: string, domain: string, version: number, opts: any = {}) {
  const res = await post(`${api}/certs`, {
    domain,
    version,
    content: `cert-${domain}-v${version}`,
    notBefore: new Date(Date.now() - 3600_000).toISOString(),
    notAfter: new Date(Date.now() + 86400_000).toISOString(),
    ...opts,
  });
  expect(res.status).toBe(201);
  return res.body;
}

export async function createNode(api: string, simUrl: string, name: string, domains: string[], cert: any = null) {
  const res = await post(`${api}/nodes`, {
    name,
    domains,
    currentCertId: cert?.id ?? null,
    currentCertVersion: cert?.version ?? null,
  });
  expect(res.status).toBe(201);
  const node = res.body;
  // register the physical node in the simulator with the same id
  const reg = await post(`${simUrl}/admin/nodes`, {
    nodeId: node.id,
    certId: cert?.id ?? null,
    version: cert?.version ?? null,
  });
  expect(reg.status).toBe(200);
  return node;
}

export async function setBehavior(simUrl: string, nodeId: string, mode: string, latencyMs = 50) {
  const res = await post(`${simUrl}/admin/behavior`, { nodeId, mode, latencyMs });
  expect(res.status).toBe(200);
}

export async function simDispatchCount(simUrl: string, nodeId: string): Promise<number> {
  const res = await get(`${simUrl}/admin/requests?nodeId=${nodeId}`);
  return res.body.length;
}

export async function createRelease(api: string, body: any) {
  const res = await post(`${api}/releases`, body);
  expect(res.status).toBe(201);
  return res.body;
}

export async function getRelease(api: string, id: string) {
  const res = await get(`${api}/releases/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

export async function getNode(api: string, id: string) {
  const res = await get(`${api}/nodes/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

export function taskOf(detail: any, nodeId: string) {
  return detail.tasks.find((t: any) => t.node_id === nodeId);
}
