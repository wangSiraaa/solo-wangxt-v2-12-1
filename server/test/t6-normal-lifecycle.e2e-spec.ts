import {
  TestContext,
  boot,
  createCert,
  createNode,
  createRelease,
  getRelease,
  getNode,
  post,
  setBehavior,
  simDispatchCount,
  taskOf,
  waitFor,
} from './helpers';

/**
 * 验收 6: 无节点重叠的普通发布保持原有行为 ——
 * 灰度门、暂停/恢复、失败重试、整体回滚。
 */
describe('T6: normal release keeps canary gate, pause, retry and rollback behavior', () => {
  let ctx: TestContext;
  let api: string;
  const DOMAIN = 'static.example.com';

  beforeAll(async () => {
    ctx = await boot();
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    await ctx.app.close();
    ctx.sim.close();
  });

  it('runs the full gray-release lifecycle without interference', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const nodes = [];
    for (let i = 1; i <= 4; i++) {
      nodes.push(await createNode(api, ctx.simUrl, `t6-node-${i}`, [DOMAIN], v1));
    }
    const [n1, n2, n3, n4] = nodes;

    const rel = await createRelease(api, {
      name: '常规轮换-v2',
      kind: 'normal',
      certId: v2.id,
      nodeIds: nodes.map((n) => n.id),
      strategy: { canaryPercent: 25, batchSize: 1, dispatchTimeoutMs: 5000, maxAttempts: 3 },
    });
    await post(`${api}/releases/${rel.id}/start`, {});

    // --- gray gate: canary node only, then wait for manual promotion
    const gated = await waitFor(
      () => getRelease(api, rel.id),
      (r) => r.status === 'gate_paused',
      'release pauses at the gray gate',
    );
    expect(taskOf(gated, n1.id).status).toBe('success');
    expect(taskOf(gated, n2.id).status).toBe('pending');
    expect(await simDispatchCount(ctx.simUrl, n2.id)).toBe(0);

    // --- promote, then pause while n2 is in flight
    await setBehavior(ctx.simUrl, n2.id, 'hold');
    await post(`${api}/releases/${rel.id}/promote`, {});
    await waitFor(
      () => getRelease(api, rel.id),
      (r) => taskOf(r, n2.id)?.status === 'in_flight',
      'n2 dispatched',
    );
    await post(`${api}/releases/${rel.id}/pause`, {});
    // in-flight request still completes while paused, but nothing new is dispatched
    await post(`${ctx.simUrl}/admin/flush`, { nodeId: n2.id });
    await waitFor(
      () => getRelease(api, rel.id),
      (r) => taskOf(r, n2.id)?.status === 'success',
      'n2 completes during pause',
    );
    const paused = await getRelease(api, rel.id);
    expect(paused.status).toBe('paused');
    expect(taskOf(paused, n3.id).status).toBe('pending');
    expect(await simDispatchCount(ctx.simUrl, n3.id)).toBe(0);
    await setBehavior(ctx.simUrl, n2.id, 'auto');

    // --- resume; n3 fails, release turns failed
    await setBehavior(ctx.simUrl, n3.id, 'fail');
    await post(`${api}/releases/${rel.id}/resume`, {});
    const failed = await waitFor(
      () => getRelease(api, rel.id),
      (r) => r.status === 'failed',
      'release fails on n3',
    );
    expect(taskOf(failed, n3.id).status).toBe('failed');
    expect(await simDispatchCount(ctx.simUrl, n4.id)).toBe(0);

    // --- retry the failed task after fixing the node
    await setBehavior(ctx.simUrl, n3.id, 'auto');
    const retried = await post(`${api}/releases/${rel.id}/retry`, {});
    expect(retried.status).toBe(201);
    const completed = await waitFor(
      () => getRelease(api, rel.id),
      (r) => r.status === 'completed',
      'release completes after retry',
    );
    expect(completed.tasks.every((t: any) => t.status === 'success')).toBe(true);
    for (const n of nodes) {
      expect((await getNode(api, n.id)).current_cert_version).toBe(2);
    }

    // --- rollback: every node returns to the previous cert
    await post(`${api}/releases/${rel.id}/rollback`, {});
    const rolledBack = await waitFor(
      () => getRelease(api, rel.id),
      (r) => r.status === 'rolled_back',
      'release rolls back',
    );
    expect(rolledBack.tasks.every((t: any) => t.status === 'rolled_back')).toBe(true);
    for (const n of nodes) {
      expect((await getNode(api, n.id)).current_cert_version).toBe(1);
    }

    // control history: exactly one 'schedule' claim per node, no takeovers
    const nodeDetail = await getNode(api, n1.id);
    expect(nodeDetail.switches.filter((s: any) => s.reason === 'schedule')).toHaveLength(1);
    expect(nodeDetail.switches.filter((s: any) => s.reason === 'emergency_takeover')).toHaveLength(0);
  });
});
