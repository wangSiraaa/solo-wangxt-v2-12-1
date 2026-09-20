import {
  TestContext,
  bootOnPort,
  createCert,
  createNode,
  createRelease,
  getFreePort,
  getRelease,
  post,
  get,
  setBehavior,
  startApp,
  simDispatchCount,
  taskOf,
  waitFor,
} from './helpers';

/**
 * 验收 4: 执行中服务重启 —— 从数据库恢复控制权与未完成任务：
 * 已成功节点不重推，未完成节点恰好继续一次。
 */
describe('T4: restart mid-execution recovers control and unfinished tasks from the DB', () => {
  let ctx: TestContext;
  let api: string;
  let port: number;
  const DOMAIN = 'cdn.example.com';

  beforeAll(async () => {
    port = await getFreePort();
    ctx = await bootOnPort(port);
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    ctx.sim.close();
  });

  it('does not re-push succeeded nodes and continues unfinished ones exactly once', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const nodes = [];
    for (let i = 1; i <= 3; i++) {
      nodes.push(await createNode(api, ctx.simUrl, `t4-node-${i}`, [DOMAIN], v1));
    }
    const [n1, n2, n3] = nodes;

    // n1 responds quickly; n2/n3 hang so they are mid-flight at "crash" time
    await setBehavior(ctx.simUrl, n2.id, 'hold');
    await setBehavior(ctx.simUrl, n3.id, 'hold');

    const normal = await createRelease(api, {
      name: '常规轮换-v2',
      kind: 'normal',
      certId: v2.id,
      nodeIds: nodes.map((n) => n.id),
      strategy: { canaryPercent: 10, batchSize: 2, dispatchTimeoutMs: 60000, maxAttempts: 3 },
    });
    await post(`${api}/releases/${normal.id}/start`, {});

    // canary (n1) succeeds -> gate; promote -> n2/n3 dispatched and held
    await waitFor(
      () => getRelease(api, normal.id),
      (r) => r.status === 'gate_paused',
      'release reaches gray gate',
    );
    await post(`${api}/releases/${normal.id}/promote`, {});
    await waitFor(
      () => getRelease(api, normal.id),
      (r) =>
        taskOf(r, n2.id)?.status === 'in_flight' && taskOf(r, n3.id)?.status === 'in_flight',
      'n2/n3 in flight',
    );
    expect(await simDispatchCount(ctx.simUrl, n1.id)).toBe(1);
    expect(await simDispatchCount(ctx.simUrl, n2.id)).toBe(1);

    // simulate a crash: close the app (sweeper stops), keep DB + simulator
    await ctx.app.close();

    // boot a fresh app instance on the same port against the same database
    // -> recovery runs from the DB, and stale callbacks can still find us
    const restarted = await startApp(ctx.dbUrl, ctx.simUrl, port);
    api = restarted.api;

    try {
      // unfinished tasks re-dispatched exactly once; succeeded task untouched
      await waitFor(
        () => simDispatchCount(ctx.simUrl, n2.id),
        (c) => c === 2,
        'n2 re-dispatched exactly once',
      );
      await waitFor(
        () => simDispatchCount(ctx.simUrl, n3.id),
        (c) => c === 2,
        'n3 re-dispatched exactly once',
      );
      // give the engine a moment to prove it does not re-push n1 or double-dispatch
      await new Promise((r) => setTimeout(r, 600));
      expect(await simDispatchCount(ctx.simUrl, n1.id)).toBe(1);
      expect(await simDispatchCount(ctx.simUrl, n2.id)).toBe(2);
      expect(await simDispatchCount(ctx.simUrl, n3.id)).toBe(2);

      // release is running again with control intact
      const recovered = await getRelease(api, normal.id);
      expect(recovered.status).toBe('running');
      expect(taskOf(recovered, n1.id).status).toBe('success');
      expect(taskOf(recovered, n2.id).status).toBe('in_flight');

      // let the held requests complete; the release must finish
      await post(`${ctx.simUrl}/admin/flush`, {});
      const done = await waitFor(
        () => getRelease(api, normal.id),
        (r) => r.status === 'completed',
        'release completes after recovery',
      );
      expect(done.tasks.every((t: any) => ['success'].includes(t.status))).toBe(true);

      // the stale pre-restart requests' receipts arrive late and are audited only
      const receipts = await get(`${api}/receipts?releaseId=${normal.id}`).then((r) => r.body);
      const late = receipts.filter((r: any) => r.late);
      expect(late.length).toBeGreaterThanOrEqual(2);
      expect(late.every((r: any) => r.applied === false)).toBe(true);
    } finally {
      await restarted.app.close();
    }
  });
});
