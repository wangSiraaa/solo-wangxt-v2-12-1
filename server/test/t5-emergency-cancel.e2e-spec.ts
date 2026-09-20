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
 * 验收 5: 紧急发布部分成功后取消。
 *  - 成功节点逐节点回到接管前仍有效且匹配域名的证书
 *  - 失败节点保留实际版本与失败审计
 *  - 被取代的旧计划不会自动恢复
 *  - 前置证书已失效的节点保持实际版本并留下说明
 */
describe('T5: cancel an emergency release after partial success', () => {
  let ctx: TestContext;
  let api: string;
  const DOMAIN = 'shop.example.com';

  beforeAll(async () => {
    ctx = await boot();
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    await ctx.app.close();
    ctx.sim.close();
  });

  it('restores succeeded nodes, keeps failed-node audit, never resumes the old plan', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const v3 = await createCert(api, DOMAIN, 3);
    const n1 = await createNode(api, ctx.simUrl, 't5-node-1', [DOMAIN], v1);
    const n2 = await createNode(api, ctx.simUrl, 't5-node-2', [DOMAIN], v1);

    // old normal plan stalls: both nodes hold the request until it times out
    await setBehavior(ctx.simUrl, n1.id, 'hold');
    await setBehavior(ctx.simUrl, n2.id, 'hold');
    const normal = await createRelease(api, {
      name: '常规轮换-v2',
      kind: 'normal',
      certId: v2.id,
      nodeIds: [n1.id, n2.id],
      strategy: { canaryPercent: 100, batchSize: 2, dispatchTimeoutMs: 300, maxAttempts: 3 },
    });
    await post(`${api}/releases/${normal.id}/start`, {});
    await waitFor(
      () => getRelease(api, normal.id),
      (r) => r.status === 'failed',
      'normal release fails on timeouts',
    );

    // emergency plan: n1 will succeed, n2 will fail
    await setBehavior(ctx.simUrl, n1.id, 'auto');
    await setBehavior(ctx.simUrl, n2.id, 'fail');
    const emergency = await createRelease(api, {
      name: '紧急证书-v3',
      kind: 'emergency',
      certId: v3.id,
      nodeIds: [n1.id, n2.id],
      strategy: { dispatchTimeoutMs: 5000, maxAttempts: 3 },
    });
    await post(`${api}/releases/${emergency.id}/takeover`, { operator: 'op-emergency' });
    const partial = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'failed',
      'emergency release partially fails',
    );
    expect(taskOf(partial, n1.id).status).toBe('success');
    expect(taskOf(partial, n2.id).status).toBe('failed');
    expect((await getNode(api, n1.id)).current_cert_version).toBe(3);
    expect((await getNode(api, n2.id)).current_cert_version).toBe(1); // push failed, keeps v1

    // old plan was superseded by the takeover
    expect((await getRelease(api, normal.id)).status).toBe('superseded');

    // cancel the emergency release after partial success
    const cancel = await post(`${api}/releases/${emergency.id}/cancel`, { reason: '紧急证书回退' });
    expect(cancel.status).toBe(201);

    const cancelled = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'cancelled' && taskOf(r, n1.id).status === 'rolled_back',
      'n1 restored to pre-takeover cert',
    );
    // n1 returned to the pre-takeover cert (v1, still valid & domain matches)
    expect((await getNode(api, n1.id)).current_cert_version).toBe(1);
    // failed node keeps its actual version and its failure audit
    const failedTask = taskOf(cancelled, n2.id);
    expect(failedTask.status).toBe('failed');
    expect(failedTask.last_error).toBeTruthy();
    expect((await getNode(api, n2.id)).current_cert_version).toBe(1);

    // the superseded plan is NOT auto-resumed
    expect((await getRelease(api, normal.id)).status).toBe('superseded');

    // restore receipt was applied and audited
    const receipts = (await get(`${api}/receipts?releaseId=${emergency.id}`)).body;
    const restoreReceipt = receipts.find((r: any) => r.note && r.note.includes('restore'));
    expect(restoreReceipt).toBeDefined();
    expect(restoreReceipt.applied).toBe(true);
  });

  it('keeps the actual version when the pre-takeover cert is no longer valid', async () => {
    const DOMAIN2 = 'pay.example.com';
    const v1 = await createCert(api, DOMAIN2, 1);
    const v2 = await createCert(api, DOMAIN2, 2);
    const node = await createNode(api, ctx.simUrl, 't5-node-9', [DOMAIN2], v1);

    const emergency = await createRelease(api, {
      name: '紧急证书-v2',
      kind: 'emergency',
      certId: v2.id,
      nodeIds: [node.id],
      strategy: { dispatchTimeoutMs: 5000 },
    });
    await post(`${api}/releases/${emergency.id}/takeover`, { operator: 'op-emergency' });
    await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'completed',
      'emergency completes',
    );
    expect((await getNode(api, node.id)).current_cert_version).toBe(2);

    // revoke the pre-takeover cert, then cancel: node must keep v2
    await post(`${api}/certs/${v1.id}/revoke`, {});
    await post(`${api}/releases/${emergency.id}/cancel`, { reason: '前置证书已吊销' });
    const cancelled = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'cancelled',
      'emergency cancelled',
    );
    const task = taskOf(cancelled, node.id);
    expect(task.status).toBe('success'); // not restored
    expect(task.note).toContain('not restorable');
    expect((await getNode(api, node.id)).current_cert_version).toBe(2);
  });
});
