# 证书发布平台（含紧急证书接管）

企业级证书轮换平台：**NestJS + PostgreSQL + Vue 3 + 节点模拟器**。支持普通灰度发布
（金丝雀门 / 暂停 / 重试 / 回滚）与**高优先级紧急接管**：当普通轮换停在灰度门、
执行中或部分节点失败时，可创建紧急发布，预览冲突节点并人工确认后原子接管。

## 核心语义

| 能力 | 实现 |
| --- | --- |
| 发布优先级 | `releases.priority` 持久化（紧急默认 100，普通默认 10） |
| 节点控制权代次 | `node_control` 每节点一行：`release_id` + 单调递增 `epoch`，任何时刻一个节点只有一个有效控制计划 |
| superseded 历史 | `control_switches` 仅追加（含 `UNIQUE(node_id, to_epoch)`），旧计划 `status='superseded'` + 被替代原因 |
| 原子接管 | 单事务内：行锁（`FOR UPDATE`，按节点 id 排序防死锁）→ 代次 +1 → 切换记录 → 旧计划在途请求 orphan → 旧任务 superseded → 新任务创建 |
| 已成功节点不覆盖 | 旧计划已 `success` 的节点被紧急计划 **adopt**：控制权转移但不重推、不改写节点证书；切换记录永不 UPDATE |
| 旧请求先结束/超时 | 接管即在途请求标记 `orphaned`；超时清扫器标记 `timed_out` |
| 迟到回执 | 请求非在途或 `(release, epoch)` 不再控制节点 → 仅审计（`late=true, applied=false`），不改写节点实际证书 / 任务状态 / 灰度门 |
| 重启恢复 | 启动时从 DB 恢复：`running` 计划的在途请求 orphan、任务回 `pending` 后**恰好重派一次**；已成功节点不重推；引擎不依赖进程内集合 |
| 紧急取消 | 成功节点逐节点恢复到接管前**仍有效且域名匹配**的证书；失败节点保留实际版本与失败审计；旧计划不自动恢复 |

## 目录

```
server/      NestJS API（TypeORM + PostgreSQL，内嵌 PG 用于开发/测试）
  src/entities.ts          实体：证书/节点/发布/任务/控制权/切换记录/在途请求/回执
  src/releases.service.ts  生命周期：启动、接管预览、原子接管、灰度门、暂停、重试、回滚、取消
  src/receipts.service.ts  回执处理（epoch 校验，迟到仅审计）
  src/engine.service.ts    DB 驱动引擎：派发、阶段推进、超时清扫、重启恢复
  test/                    6 个验收场景 e2e（真实 PostgreSQL + 真实模拟器）
web/         Vue 3 + Vite 前端
simulator/   零依赖节点模拟器（持有物理证书状态，支持 auto/fail/hold 行为）
scripts/     种子数据脚本
```

## 快速开始

```bash
npm run setup            # 安装 server 与 web 依赖

# 终端 1：PostgreSQL（embedded，端口 5433，数据在 server/.pgdata）
npm run db

# 终端 2：节点模拟器（端口 4100）
npm run dev:simulator

# 终端 3：API 服务（端口 3000）
npm run dev:server

# 终端 4：前端（端口 5173，代理 /api -> 3000）
npm run dev:web

# 可选：灌入演示数据（一个停在灰度门的普通计划 + 一个待确认的紧急计划）
npm run seed
```

打开 http://localhost:5173 ：进入紧急发布详情 →「预览冲突并接管」→ 确认接管。

## 测试（验收覆盖）

```bash
npm test
```

| 场景 | 文件 |
| --- | --- |
| 普通计划停在 canary 门后被紧急计划接管（含 adopt、冲突拒绝、代次/切换记录） | `server/test/t1-canary-gate-takeover.e2e-spec.ts` |
| 旧超时请求在接管后成功回执但不反写（审计保留） | `server/test/t2-late-receipt.e2e-spec.ts` |
| 两个操作者并发接管：仅一个成功、无重复切换日志 | `server/test/t3-concurrent-takeover.e2e-spec.ts` |
| 执行中重启：已成功节点不重推、未完成节点继续一次 | `server/test/t4-restart-recovery.e2e-spec.ts` |
| 紧急计划部分成功后取消：逐节点恢复、失败审计保留、旧计划不恢复、前置证书失效时保留实际版本 | `server/test/t5-emergency-cancel.e2e-spec.ts` |
| 无重叠普通发布：灰度门 / 暂停 / 重试 / 回滚行为不变 | `server/test/t6-normal-lifecycle.e2e-spec.ts` |

测试使用 `embedded-postgres` 启动真实 PostgreSQL 18（随机临时数据目录），
模拟器以独立 HTTP 服务在进程内随机端口运行。

## API 摘要

```
POST   /api/certs                         录入证书        GET /api/certs
POST   /api/certs/:id/revoke              吊销证书
POST   /api/nodes                         接入节点        GET /api/nodes（含当前控制计划/代次/迟到回执数）
GET    /api/nodes/:id                     节点详情（切换历史 + 回执归属）
POST   /api/releases                      创建发布（normal|emergency，含 strategy/priority）
POST   /api/releases/:id/start            启动普通发布（冲突 409）
GET    /api/releases/:id/takeover-preview 接管冲突预览（claim/takeover/adopt）
POST   /api/releases/:id/takeover         确认接管（原子，幂等，并发仅一个成功）
POST   /api/releases/:id/promote|pause|resume|retry|rollback|cancel
POST   /api/receipts                      模拟器回执入口（迟到仅审计）
GET    /api/receipts?nodeId=&releaseId=&late=true
POST   /api/admin/recover                 手动触发重启恢复（启动时自动执行）
```

## 模拟器行为控制

```bash
curl -X POST localhost:4100/admin/behavior -H 'content-type: application/json' \
  -d '{"nodeId":"<node-uuid>","mode":"hold"}'        # auto|fail|hold
curl -X POST localhost:4100/admin/flush -H 'content-type: application/json' -d '{}'  # 让挂起请求完成（产生迟到回执）
curl localhost:4100/admin/state                       # 物理证书状态与请求日志
```
