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
  taskOf,
  waitFor,
  simDispatchCount,
} from './helpers';

/**
 * 验收 1: 普通计划停在 canary 灰度门后，被紧急计划原子接管。
 *  - 普通计划停在 gate_paused
 *  - 紧急计划预览冲突并确认接管
 *  - 已成功节点被 adopt（不重推、不覆盖实际证书）
 *  - 旧计划 superseded 且带被替代原因，控制权代次 +1，切换记录完整
 */
describe('T1: emergency takeover of a release stuck at the canary gate', () => {
  let ctx: TestContext;
  let api: string;
  const DOMAIN = 'api.example.com';

  beforeAll(async () => {
    ctx = await boot();
    api = ctx.api;
  }, 120000);

  afterAll(async () => {
    await ctx.app.close();
    ctx.sim.close();
  });

  it('takes over atomically and adopts succeeded nodes', async () => {
    const v1 = await createCert(api, DOMAIN, 1);
    const v2 = await createCert(api, DOMAIN, 2);
    const v3 = await createCert(api, DOMAIN, 3);
    const nodes = [];
    for (let i = 1; i <= 4; i++) {
      nodes.push(await createNode(api, ctx.simUrl, `t1-node-${i}`, [DOMAIN], v1));
    }
    const nodeIds = nodes.map((n) => n.id);

    // normal release: 25% canary => 1 node, then batches of 3
    const normal = await createRelease(api, {
      name: '常规轮换-v2',
      kind: 'normal',
      certId: v2.id,
      nodeIds,
      strategy: { canaryPercent: 25, batchSize: 3, dispatchTimeoutMs: 5000, maxAttempts: 3 },
      createdBy: 'op-normal',
    });
    const started = await post(`${api}/releases/${normal.id}/start`, { operator: 'op-normal' });
    expect(started.status).toBe(201);

    // wait for the gray gate
    const gated = await waitFor(
      () => getRelease(api, normal.id),
      (r) => r.status === 'gate_paused',
      'normal release reaches gate_paused',
    );
    expect(taskOf(gated, nodes[0].id).status).toBe('success');
    expect((await getNode(api, nodes[0].id)).current_cert_version).toBe(2);
    // remaining nodes untouched
    for (const n of nodes.slice(1)) {
      expect(taskOf(gated, n.id).status).toBe('pending');
    }

    // a second normal release over the same nodes must be rejected
    const other = await createRelease(api, {
      name: '常规轮换-v2-冲突',
      kind: 'normal',
      certId: v2.id,
      nodeIds,
    });
    const rejected = await post(`${api}/releases/${other.id}/start`, {});
    expect(rejected.status).toBe(409);

    // emergency release over the same nodes
    const emergency = await createRelease(api, {
      name: '紧急证书-v3',
      kind: 'emergency',
      certId: v3.id,
      nodeIds,
      strategy: { dispatchTimeoutMs: 5000, maxAttempts: 3 },
      createdBy: 'op-emergency',
    });
    expect(emergency.priority).toBe(100);

    // conflict preview
    const previewRes = await get(`${api}/releases/${emergency.id}/takeover-preview`);
    expect(previewRes.status).toBe(200);
    const preview = previewRes.body;
    expect(preview.conflicts).toBe(4);
    const byNode = new Map(preview.nodes.map((n: any) => [n.nodeId, n]));
    expect(byNode.get(nodes[0].id).action).toBe('adopt');
    expect(byNode.get(nodes[0].id).controlledBy.releaseId).toBe(normal.id);
    expect(byNode.get(nodes[1].id).action).toBe('takeover');

    // confirm takeover
    const takeover = await post(`${api}/releases/${emergency.id}/takeover`, { operator: 'op-emergency' });
    expect(takeover.status).toBe(201);

    // old release superseded with reason
    const oldAfter = await getRelease(api, normal.id);
    expect(oldAfter.status).toBe('superseded');
    expect(oldAfter.superseded_by_release_id).toBe(emergency.id);
    expect(oldAfter.state_reason).toContain('紧急发布');
    // old success task preserved as history, pending ones superseded
    expect(taskOf(oldAfter, nodes[0].id).status).toBe('success');
    expect(taskOf(oldAfter, nodes[1].id).status).toBe('superseded');

    // emergency completes on the non-adopted nodes
    const done = await waitFor(
      () => getRelease(api, emergency.id),
      (r) => r.status === 'completed',
      'emergency release completes',
    );
    expect(taskOf(done, nodes[0].id).status).toBe('adopted');
    for (const n of nodes.slice(1)) {
      expect(taskOf(done, n.id).status).toBe('success');
    }

    // succeeded node was NOT re-pushed nor overwritten: still v2
    expect(await simDispatchCount(ctx.simUrl, nodes[0].id)).toBe(1);
    expect((await getNode(api, nodes[0].id)).current_cert_version).toBe(2);
    // taken-over nodes now run the emergency cert
    for (const n of nodes.slice(1)) {
      expect((await getNode(api, n.id)).current_cert_version).toBe(3);
    }

    // control records: emergency controls every node at epoch 2
    for (const n of nodes) {
      const detail = await getNode(api, n.id);
      expect(detail.control.release_id).toBe(emergency.id);
      expect(detail.control.epoch).toBe(2);
    }

    // switch history: one emergency_takeover record per node
    const switches = (await getRelease(api, emergency.id)).switches.filter(
      (s: any) => s.to_release_id === emergency.id,
    );
    expect(switches).toHaveLength(4);
    expect(switches.every((s: any) => s.reason === 'emergency_takeover')).toBe(true);
    expect(switches.every((s: any) => s.from_release_id === normal.id)).toBe(true);
  });
});
