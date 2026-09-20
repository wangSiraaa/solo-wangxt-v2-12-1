import {
  TestContext,
  boot,
  createCert,
  createNode,
  createRelease,
  getRelease,
  getNode,
  post,
  get,
  setBehavior,
  waitFor,
} from './helpers';

/**
 * 验收 3: 两个操作者并发确认同一个紧急接管 —— 仅一个成功，
 * 且每个节点只有一条切换日志、代次只 +1。
 */
describe('T3: concurrent takeover confirmations resolve to exactly one winner', () => {
  let ctx: TestContext;
  let api: string;
  const DOMAIN = 'auth.example.com';

  beforeAll(async () => {
    ctx = await boot();
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    await ctx.app.close();
    ctx.sim.close();
  });

  it('allows exactly one takeover and writes no duplicate switch logs', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const v3 = await createCert(api, DOMAIN, 3);
    const nodes = [];
    for (let i = 1; i <= 3; i++) {
      nodes.push(await createNode(api, ctx.simUrl, `t3-node-${i}`, [DOMAIN], v1));
    }
    const nodeIds = nodes.map((n) => n.id);

    // normal release running with held requests (mid-execution)
    for (const n of nodes) await setBehavior(ctx.simUrl, n.id, 'hold');
    const normal = await createRelease(api, {
      name: '常规轮换-v2',
      kind: 'normal',
      certId: v2.id,
      nodeIds,
      strategy: { canaryPercent: 100, batchSize: 3, dispatchTimeoutMs: 60000, maxAttempts: 3 },
    });
    await post(`${api}/releases/${normal.id}/start`, {});
    await waitFor(
      () => getRelease(api, normal.id),
      (r) => r.tasks.every((t: any) => t.status === 'in_flight'),
      'all tasks in flight',
    );

    const emergency = await createRelease(api, {
      name: '紧急证书-v3',
      kind: 'emergency',
      certId: v3.id,
      nodeIds,
      strategy: { dispatchTimeoutMs: 5000 },
    });

    // two operators confirm the same takeover concurrently
    const [r1, r2] = await Promise.all([
      post(`${api}/releases/${emergency.id}/takeover`, { operator: 'alice' }),
      post(`${api}/releases/${emergency.id}/takeover`, { operator: 'bob' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // exactly one switch record per node, epoch bumped exactly once
    for (const n of nodes) {
      const detail = await getNode(api, n.id);
      expect(detail.control.release_id).toBe(emergency.id);
      expect(detail.control.epoch).toBe(2);
      const takeovers = detail.switches.filter((s: any) => s.reason === 'emergency_takeover');
      expect(takeovers).toHaveLength(1);
      expect(takeovers[0].to_epoch).toBe(2);
      expect(takeovers[0].from_release_id).toBe(normal.id);
    }

    // old plan superseded exactly once, emergency completes
    const normalAfter = await getRelease(api, normal.id);
    expect(normalAfter.status).toBe('superseded');
    // emergency tasks were dispatched at takeover; nodes are in hold mode -> flush them
    await post(`${ctx.simUrl}/admin/flush`, {});
    const done = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'completed',
      'emergency release completes',
    );
    expect(done.tasks.every((t: any) => t.status === 'success')).toBe(true);

    // the emergency release shows exactly 3 tasks (no duplicates from the loser)
    expect(done.tasks).toHaveLength(3);
  });
});
