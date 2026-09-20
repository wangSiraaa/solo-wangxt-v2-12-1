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
  taskOf,
  waitFor,
} from './helpers';

/**
 * 验收 2: 旧计划的超时请求在接管之后送达成功回执 —— 必须审计但不得回写。
 *  - 旧请求超时 -> 任务失败
 *  - 紧急计划接管并推送新证书
 *  - 旧成功回执迟到到达：记入审计（late, applied=false），
 *    节点实际证书、任务状态、灰度门均不被改写
 */
describe('T2: late receipt after takeover is audited but never applied', () => {
  let ctx: TestContext;
  let api: string;
  const DOMAIN = 'pay.example.com';

  beforeAll(async () => {
    ctx = await boot();
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    await ctx.app.close();
    ctx.sim.close();
  });

  it('does not rewrite node cert, task state or gate from a stale receipt', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const v3 = await createCert(api, DOMAIN, 3);
    const node = await createNode(api, ctx.simUrl, 't2-node-1', [DOMAIN], v1);

    // node holds the request: the platform will time it out
    await setBehavior(ctx.simUrl, node.id, 'hold');

    const normal = await createRelease(api, {
      name: '常规轮换-v2-慢节点',
      kind: 'normal',
      certId: v2.id,
      nodeIds: [node.id],
      strategy: { canaryPercent: 100, batchSize: 1, dispatchTimeoutMs: 300, maxAttempts: 3 },
    });
    await post(`${api}/releases/${normal.id}/start`, {});

    // sweeper marks the in-flight request timed out -> task failed
    const failedRel = await waitFor(
      () => getRelease(api, normal.id),
      (r) => r.status === 'failed',
      'normal release fails on dispatch timeout',
    );
    expect(taskOf(failedRel, node.id).status).toBe('failed');
    expect(taskOf(failedRel, node.id).last_error).toContain('timeout');

    // emergency release takes over the node and pushes v3; the node answers
    // new requests promptly now (the old held request stays held)
    await setBehavior(ctx.simUrl, node.id, 'auto');
    const emergency = await createRelease(api, {
      name: '紧急证书-v3',
      kind: 'emergency',
      certId: v3.id,
      nodeIds: [node.id],
      strategy: { dispatchTimeoutMs: 5000 },
    });
    const takeover = await post(`${api}/releases/${emergency.id}/takeover`, { operator: 'op-emergency' });
    expect(takeover.status).toBe(201);
    const done = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'completed',
      'emergency release completes',
    );
    expect(taskOf(done, node.id).status).toBe('success');
    expect((await getNode(api, node.id)).current_cert_version).toBe(3);

    // the old plan's request finally succeeds on the node and calls back late
    const flushed = await post(`${ctx.simUrl}/admin/flush`, { nodeId: node.id });
    expect(flushed.body.flushed.length).toBe(1);

    const receipts = await waitFor(
      () => get(`${api}/receipts?nodeId=${node.id}&late=true`).then((r) => r.body),
      (list) => list.length >= 1,
      'late receipt is audited',
    );
    const late = receipts.find((r: any) => r.release_id === normal.id);
    expect(late).toBeDefined();
    expect(late.applied).toBe(false);
    expect(late.late).toBe(true);
    expect(late.outcome).toBe('success');
    expect(late.note).toMatch(/timed_out|orphaned|superseded/);

    // nothing was rewritten by the stale success receipt
    const nodeAfter = await getNode(api, node.id);
    expect(nodeAfter.current_cert_version).toBe(3); // still the emergency cert
    expect(nodeAfter.cert_updated_by_release_id).toBe(emergency.id);
    const emergencyAfter = await getRelease(api, emergency.id);
    expect(emergencyAfter.status).toBe('completed');
    expect(taskOf(emergencyAfter, node.id).status).toBe('success');
    const normalAfter = await getRelease(api, normal.id);
    expect(normalAfter.status).toBe('superseded');
    expect(taskOf(normalAfter, node.id).status).toBe('superseded');
    // control stays with the emergency release at the bumped epoch
    expect(nodeAfter.control.release_id).toBe(emergency.id);
    expect(nodeAfter.control.epoch).toBe(2);
  });
});
