import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PgliteDbService } from '../db/pglite-db.service.js';
import { NodeSimulatorService } from '../simulator/node-simulator.service.js';
import { SeedService } from '../seed/seed.service.js';
import { ReleasesService } from './releases.service.js';

const domain = 'payments.example.internal';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  db: PgliteDbService;
  simulator: NodeSimulatorService;
  seed: SeedService;
  service: ReleasesService;
}

async function createHarness(): Promise<Harness> {
  const db = await PgliteDbService.create();
  const simulator = new NodeSimulatorService();
  const seed = new SeedService(db);
  await seed.seedIfEmpty();
  const service = new ReleasesService(db, simulator, seed);
  await service.onModuleInit();
  return { db, simulator, seed, service };
}

async function closeHarness(harness: Harness) {
  await harness.service.onModuleDestroy();
  await harness.db.close();
}

async function row<T = any>(harness: Harness, sql: string, params: unknown[] = []): Promise<T> {
  const result = await harness.db.query<T>(sql, params);
  return result.rows[0] as T;
}

async function rows<T = any>(harness: Harness, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await harness.db.query<T>(sql, params);
  return result.rows;
}

const normalDto = (nodes = ['node-a', 'node-b', 'node-c', 'node-d']) => ({
  priority: 'normal' as const,
  domain,
  certVersion: 'cert-rotation',
  nodeIds: nodes,
  canary: true,
  reason: 'scheduled rotation',
  createdBy: 'alice',
});

const emergencyDto = (nodes = ['node-a', 'node-b', 'node-c', 'node-d']) => ({
  priority: 'emergency' as const,
  domain,
  certVersion: 'cert-emergency',
  nodeIds: nodes,
  reason: 'private key exposure requires immediate replacement',
  createdBy: 'incident-commander',
});

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await closeHarness(harness);
  harness = null;
});

test('canary-gated normal release is atomically superseded and a late success receipt is audited without writeback', async () => {
  harness = await createHarness();
  await harness.service.setNodeBehavior('node-a', 'late_success');

  const normal = await harness.service.createNormal(normalDto());
  await sleep(300);
  const normalState = await harness.service.getReleaseDetails(normal.id);
  assert.equal(normalState.release.state, 'waiting_canary');
  const oldTask = await row(harness, `SELECT * FROM tasks WHERE release_id = $1 AND node_id = 'node-a'`, [normal.id]);

  const preview = await harness.service.previewEmergency(emergencyDto());
  assert.equal(preview.conflicts.length, 4);
  assert.deepEqual(preview.conflicts.map((c) => c.generation), [1, 1, 1, 1]);

  const emergency = await harness.service.confirmEmergency(emergencyDto());
  await sleep(1800);

  const controls = await rows(harness, `SELECT * FROM node_controls ORDER BY node_id`);
  assert.equal(controls.length, 4);
  assert.ok(controls.every((c) => c.release_id === emergency.id));
  assert.equal(Number(controls.find((c) => c.node_id === 'node-a')!.generation), 2);

  const staleReceipt = await row(harness, 'SELECT * FROM node_receipts WHERE task_id = $1', [oldTask.id]);
  assert.equal(staleReceipt.accepted, false);
  assert.equal(staleReceipt.success, true);
  assert.match(staleReceipt.rejection_reason, /controlled by|Superseded within control generation/);

  const nodeA = await row(harness, `SELECT n.*, c.version FROM nodes n JOIN certificates c ON c.id = n.current_cert_id WHERE n.id='node-a'`);
  assert.equal(nodeA.current_cert_id, 'cert-emergency');

  const oldTaskAfter = await row(harness, `SELECT state FROM tasks WHERE id = $1`, [oldTask.id]);
  assert.equal(oldTaskAfter.state, 'stale_receipt');
  const oldNodeA = await row(harness, `SELECT state FROM release_nodes WHERE release_id = $1 AND node_id = 'node-a'`, [normal.id]);
  assert.equal(oldNodeA.state, 'superseded');
  const switchOwners = await rows(harness, `SELECT DISTINCT release_id FROM node_cert_events WHERE node_id = 'node-a'`);
  assert.deepEqual(switchOwners.map((s) => s.release_id), [emergency.id]);
});

test('two operators can concurrently attempt takeover but exactly one commits and produces one switch per node', async () => {
  harness = await createHarness();
  const normal = await harness.service.createNormal(normalDto());
  await sleep(350);
  assert.equal((await harness.service.getReleaseDetails(normal.id)).release.state, 'paused');

  const first = harness.service.confirmEmergency({ ...emergencyDto(), emergencyReleaseId: 'emergency-one' });
  const second = harness.service.confirmEmergency({ ...emergencyDto(), emergencyReleaseId: 'emergency-two' });
  const outcomes = await Promise.allSettled([first, second]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  await sleep(800);
  const emergencyReleases = await rows(harness, `SELECT id, state FROM releases WHERE priority = 'emergency'`);
  assert.equal(emergencyReleases.length, 1);
  const controls = await rows(harness, `SELECT release_id, count(*)::int AS count FROM node_controls GROUP BY release_id`);
  assert.equal(controls.length, 1);
  assert.equal(Number(controls[0].count), 4);

  const duplicatedEmergencySwitches = await rows(harness, `
    SELECT node_id, count(*)::int AS count
    FROM node_cert_events
    WHERE release_id = $1 AND kind = 'switch'
    GROUP BY node_id HAVING count(*) > 1`, [emergencyReleases[0].id]);
  assert.equal(duplicatedEmergencySwitches.length, 0);
  const supersessionRows = await rows(harness, 'SELECT * FROM release_supersessions');
  assert.equal(supersessionRows.length, 4);
});

test('restart restores controls from PostgreSQL, never repushes succeeded nodes, and requeues unfinished work once', async () => {
  harness = await createHarness();
  await harness.service.setNodeBehavior('node-a', 'late_success');
  await harness.service.setNodeBehavior('node-b', 'succeed');
  const release = await harness.service.confirmEmergency(emergencyDto(['node-a', 'node-b']));
  for (let i = 0; i < 30; i += 1) {
    const current = await rows(harness, `SELECT node_id, state FROM release_nodes WHERE release_id = $1 ORDER BY node_id`, [release.id]);
    if (current.find((n) => n.node_id === 'node-b')?.state === 'succeeded') break;
    await sleep(20);
  }

  const before = await rows(harness, `SELECT node_id, state FROM release_nodes WHERE release_id = $1 ORDER BY node_id`, [release.id]);
  assert.equal(before.find((n) => n.node_id === 'node-a')!.state, 'dispatched');
  assert.equal(before.find((n) => n.node_id === 'node-b')!.state, 'succeeded');

  await harness.service.onModuleDestroy();
  const oldDb = harness.db;
  const oldSimulator = harness.simulator;
  const oldSeed = harness.seed;

  const restartedSimulator = new NodeSimulatorService();
  const restartedService = new ReleasesService(oldDb, restartedSimulator, oldSeed);
  await oldDb.query(`UPDATE nodes SET behavior = 'succeed' WHERE id = 'node-a'`);
  await restartedService.onModuleInit();
  harness = { db: oldDb, simulator: restartedSimulator, seed: oldSeed, service: restartedService };
  assert.equal(oldSimulator.pendingRequestCount(), 0);

  await sleep(1300);
  const taskCounts = await rows<{ node_id: string; count: string; states: string[] }>(
    harness,
    `SELECT node_id, count(*)::text AS count, array_agg(state ORDER BY attempt) AS states
     FROM tasks WHERE release_id = $1 GROUP BY node_id ORDER BY node_id`,
    [release.id],
  );
  const a = taskCounts.find((t) => t.node_id === 'node-a')!;
  const b = taskCounts.find((t) => t.node_id === 'node-b')!;
  assert.equal(Number(a.count), 2);
  assert.deepEqual(a.states, ['requeued', 'succeeded']);
  assert.equal(Number(b.count), 1);
  assert.deepEqual(b.states, ['succeeded']);

  const events = await rows(harness, `SELECT node_id, count(*)::text AS count FROM node_cert_events GROUP BY node_id ORDER BY node_id`);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => Number(event.count) === 1));
});

test('emergency release can be cancelled after partial success; successful nodes restore while failure audit and actual version remain', async () => {
  harness = await createHarness();
  await harness.service.setNodeBehavior('node-c', 'fail');
  const emergency = await harness.service.confirmEmergency(emergencyDto());
  await sleep(600);

  const partial = await harness.service.getReleaseDetails(emergency.id);
  assert.equal(partial.release.state, 'partial_failed');
  const failedNode = partial.nodes.find((n) => n.node_id === 'node-c');
  assert.ok(failedNode);
  assert.equal(failedNode.state, 'failed');
  assert.match(failedNode.failure_reason, /rejected/);

  await harness.service.cancelEmergency(emergency.id);
  await sleep(700);
  const details = await harness.service.getReleaseDetails(emergency.id);
  assert.equal(details.release.state, 'cancel_partial');

  const nodeStates = Object.fromEntries(details.nodes.map((n) => [n.node_id, n]));
  assert.equal(nodeStates['node-a'].state, 'restored');
  assert.equal(nodeStates['node-b'].state, 'restored');
  assert.equal(nodeStates['node-d'].state, 'restored');
  assert.equal(nodeStates['node-c'].state, 'failed');

  const actual = await rows(harness, `SELECT n.id, c.version FROM nodes n JOIN certificates c ON c.id = n.current_cert_id ORDER BY n.id`);
  assert.deepEqual(actual.map((n) => [n.id, n.version]), [
    ['node-a', '2024-01'],
    ['node-b', '2024-01'],
    ['node-c', '2024-07'],
    ['node-d', '2024-07'],
  ]);
  const failedReceipt = await row(harness, `SELECT success, accepted FROM node_receipts WHERE node_id = 'node-c' AND release_id = $1`, [emergency.id]);
  assert.deepEqual(failedReceipt, { success: false, accepted: true });
  assert.equal((await rows(harness, 'SELECT * FROM node_controls')).length, 0);
});

test('a non-overlapping normal release retains canary pause, approval, retry, and rollback behavior', async () => {
  harness = await createHarness();
  await harness.service.setNodeBehavior('node-b', 'fail');
  const release = await harness.service.createNormal(normalDto(['node-a', 'node-b']));

  await sleep(400);
  assert.equal((await harness.service.getReleaseDetails(release.id)).release.state, 'paused');
  await harness.service.approveCanary(release.id);
  await sleep(500);
  assert.equal((await harness.service.getReleaseDetails(release.id)).release.state, 'partial_failed');

  await harness.service.setNodeBehavior('node-b', 'succeed');
  await harness.service.retryFailed(release.id);
  await sleep(500);
  assert.equal((await harness.service.getReleaseDetails(release.id)).release.state, 'succeeded');

  await harness.service.rollbackNormal(release.id);
  await sleep(600);
  const details = await harness.service.getReleaseDetails(release.id);
  assert.equal(details.release.state, 'rolled_back');
  assert.deepEqual(details.nodes.map((n) => n.state), ['restored', 'restored']);
  const restoreKinds = await rows(harness, `SELECT kind, count(*)::text AS count FROM node_cert_events GROUP BY kind ORDER BY kind`);
  assert.deepEqual(restoreKinds, [
    { kind: 'restore', count: '2' },
    { kind: 'switch', count: '2' },
  ]);
});
