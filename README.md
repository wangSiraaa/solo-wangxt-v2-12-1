# 紧急证书接管示例

本项目演示在普通证书轮换停在 canary 门、部分节点失败或请求仍在执行时，创建高优先级紧急发布并原子接管节点。

## 组成

- `server/`：NestJS 10 API、PostgreSQL 持久层、节点模拟器。
- `web/`：Vue 3 + Vite 控制台。
- `server/src/releases/releases.service.spec.ts`：基于 PGlite 的五条验收场景集成测试。

## 启动

```bash
npm install

# PostgreSQL，默认连接 postgres://localhost:5432/cert_takeover
createdb cert_takeover
npm run dev:server
npm run dev:web
```

服务首次启动会自动执行 `server/src/db/schema.ts` 建表并写入四个演示节点。也可以通过 `DATABASE_URL` 指定连接串。

## 数据模型关键点

- `releases.priority`：`normal` / `emergency`，发布优先级持久化。
- `node_controls`：节点当前唯一有效控制计划和 `generation` 控制权代次；主键保证一个节点只能有一个控制行。
- `release_supersessions`：每个被接管节点的旧计划、接管前证书和人工确认原因。
- `node_cert_events`：真实证书切换/恢复事件，仅当前控制代次的成功回执可写入，历史不覆盖。
- `node_receipts`：所有回执均落审计；迟到回执标记 `accepted=false` 和归属原因，但不改写节点证书、任务状态或灰度门。
- `tasks.state`：`dispatched/succeeded/failed/stale_receipt/requeued`。重启时未终结任务置为 `requeued`，由数据库扫描后仅再派发一次。

接管事务内按稳定顺序锁定目标节点，删除旧 `node_controls` 并插入递增代次的新控制行；同时写入 superseded 历史、更新旧计划节点状态。并发紧急接管中第二个事务会因节点锁/控制行冲突回滚。

## 紧急取消语义

紧急发布部分成功后可取消：

1. 已成功节点逐节点恢复到该紧急 `release_nodes.previous_cert_id`。
2. 恢复证书必须与发布域名匹配。
3. 失败节点不回滚、不重推，保留失败回执和实际版本。
4. 旧普通计划不会自动恢复。

## 验收测试

```bash
npm test
```

覆盖：

1. 普通计划停在 canary 门后被紧急计划接管。
2. 接管后旧超时成功回执只审计、不反写。
3. 两个操作者并发接管，仅一个成功且无紧急计划重复切换。
4. 执行中重启后成功节点不重推、未完成节点继续一次。
5. 紧急计划部分成功后取消，失败审计和实际版本保留。
6. 无节点重叠的普通发布仍保持 canary、暂停、批准、重试和回滚行为。
