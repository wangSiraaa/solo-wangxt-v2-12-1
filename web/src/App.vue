<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, Snapshot } from './api';

const snapshot = ref<Snapshot | null>(null);
const selectedReleaseId = ref('');
const releaseDetail = ref<any | null>(null);
const error = ref('');
const message = ref('');
const normalVersion = ref('cert-rotation');
const emergencyVersion = ref('cert-emergency');
const emergencyTargets = ref<string[]>([]);
const preview = ref<any | null>(null);
const confirmedEmergencyId = ref('');
const refreshTimer = ref<number>();

const domain = 'payments.example.internal';
const allNodeIds = computed(() => snapshot.value?.nodes.map((n) => n.id) ?? []);

const selectedRelease = computed(() => snapshot.value?.releases.find((r) => r.id === selectedReleaseId.value));

function notify(err: unknown) {
  error.value = err instanceof Error ? err.message : String(err);
}

async function refresh() {
  try {
    snapshot.value = await api.snapshot();
    if (selectedReleaseId.value) {
      releaseDetail.value = await api.release(selectedReleaseId.value);
    } else {
      releaseDetail.value = null;
    }
  } catch (err) {
    notify(err);
  }
}

async function reset() {
  await api.reset();
  selectedReleaseId.value = '';
  releaseDetail.value = null;
  preview.value = null;
  emergencyTargets.value = [];
  await refresh();
}

async function setBehavior(nodeId: string, behavior: string) {
  snapshot.value = await api.behavior(nodeId, behavior);
}

async function createNormal() {
  try {
    const release = await api.normal({
      priority: 'normal',
      domain,
      certVersion: normalVersion.value,
      nodeIds: allNodeIds.value,
      canary: true,
      reason: 'Scheduled certificate rotation',
      createdBy: 'platform-operator',
    });
    selectedReleaseId.value = String((release as any).id);
    message.value = '普通发布已创建，首个节点停在 canary 门';
    await refresh();
  } catch (err) { notify(err); }
}

function toggleEmergencyTarget(nodeId: string) {
  const set = new Set(emergencyTargets.value);
  if (set.has(nodeId)) set.delete(nodeId); else set.add(nodeId);
  emergencyTargets.value = [...set];
}

async function previewEmergency() {
  try {
    preview.value = await api.preview({
      priority: 'emergency',
      domain,
      certVersion: emergencyVersion.value,
      nodeIds: emergencyTargets.value,
      reason: 'Incident requires immediate certificate replacement',
      createdBy: 'incident-commander',
    });
    error.value = '';
  } catch (err) { notify(err); }
}

async function confirmEmergency() {
  try {
    const release = await api.confirm({
      priority: 'emergency',
      domain,
      certVersion: emergencyVersion.value,
      nodeIds: emergencyTargets.value,
      emergencyReleaseId: confirmedEmergencyId.value || undefined,
      reason: 'Incident requires immediate certificate replacement',
      createdBy: 'incident-commander',
    });
    selectedReleaseId.value = String((release as any).id);
    confirmedEmergencyId.value = '';
    preview.value = null;
    message.value = '接管已在一个数据库事务中提交';
    await refresh();
  } catch (err) { notify(err); }
}

async function action(fn: (id: string) => Promise<unknown>) {
  if (!selectedReleaseId.value) return;
  try { await fn(selectedReleaseId.value); await refresh(); } catch (err) { notify(err); }
}

async function selectRelease(id: string) {
  selectedReleaseId.value = id;
  await refresh();
}

function badge(state: string) { return `badge ${state}`; }

onMounted(async () => {
  await refresh();
  refreshTimer.value = window.setInterval(refresh, 600);
});
onUnmounted(() => window.clearInterval(refreshTimer.value));
</script>

<template>
  <header>
    <div>
      <h1>紧急证书接管控制台</h1>
      <div class="muted">PostgreSQL 持久化控制代次 · 原子接管 · 迟到回执审计不反写</div>
    </div>
    <button class="danger" @click="reset">重置演示数据</button>
  </header>

  <main class="stack">
    <div v-if="error" class="card error">{{ error }}</div>
    <div v-if="message" class="card ok">{{ message }}</div>

    <section class="grid cols-2">
      <div class="card stack">
        <h2>1. 普通轮换</h2>
        <div class="row">
          <label>证书版本 <input v-model="normalVersion" /></label>
          <button @click="createNormal">创建普通发布（canary）</button>
        </div>
        <p class="muted">首个节点成功后会暂停在灰度门，可人工批准、重试失败节点或回滚。</p>
      </div>

      <div class="card stack">
        <h2>2. 紧急发布冲突预览与接管确认</h2>
        <div class="row">
          <label>紧急证书 <input v-model="emergencyVersion" /></label>
        </div>
        <div class="row">
          <label v-for="node in snapshot?.nodes ?? []" :key="node.id">
            <input type="checkbox" :checked="emergencyTargets.includes(node.id)" @change="toggleEmergencyTarget(node.id)" />
            {{ node.name }}
          </label>
        </div>
        <div class="row">
          <button class="secondary" :disabled="!emergencyTargets.length" @click="previewEmergency">预览重叠</button>
          <button class="danger" :disabled="!emergencyTargets.length" @click="confirmEmergency">人工确认接管</button>
        </div>
        <div v-if="preview" class="stack">
          <div><b>{{ preview.conflicts.length }}</b> 个节点将发生控制权代次递增；非重叠普通计划不会被改动。</div>
          <table>
            <thead><tr><th>节点</th><th>当前计划</th><th>旧状态</th><th>代次</th><th>接管前证书</th></tr></thead>
            <tbody>
              <tr v-for="c in preview.conflicts" :key="c.nodeId">
                <td>{{ c.nodeName }}</td>
                <td class="muted">{{ c.releaseId.slice(0, 8) }}</td>
                <td><span :class="badge(c.state)">{{ c.state }}</span></td>
                <td>{{ c.generation }} → {{ c.generation + 1 }}</td>
                <td>{{ c.previousCertId ?? c.currentCertId }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="grid cols-2">
      <div class="card stack">
        <h2>节点模拟器与当前控制计划</h2>
        <table>
          <thead><tr><th>节点</th><th>实际证书</th><th>行为</th><th>当前控制</th><th>代次</th></tr></thead>
          <tbody>
            <tr v-for="node in snapshot?.nodes ?? []" :key="node.id">
              <td>{{ node.name }}<div class="muted">{{ node.id }}</div></td>
              <td>{{ node.current_cert_version }}</td>
              <td>
                <select :value="node.behavior" @change="setBehavior(node.id, ($event.target as HTMLSelectElement).value)">
                  <option value="succeed">成功</option>
                  <option value="fail">失败</option>
                  <option value="late_success">接管后迟到成功</option>
                </select>
              </td>
              <td>{{ node.controlling_release_id ? node.controlling_release_id.slice(0, 8) : '—' }}</td>
              <td>{{ node.control_generation ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card stack">
        <h2>发布列表</h2>
        <table>
          <thead><tr><th>选择</th><th>优先级</th><th>状态</th><th>证书</th><th>创建时间</th></tr></thead>
          <tbody>
            <tr v-for="release in snapshot?.releases ?? []" :key="release.id">
              <td><button class="secondary" @click="selectRelease(release.id)">详情</button></td>
              <td><span :class="badge(release.priority)">{{ release.priority }}</span></td>
              <td><span :class="badge(release.state)">{{ release.state }}</span></td>
              <td>{{ release.cert_version }}</td>
              <td class="muted">{{ new Date(release.created_at).toLocaleTimeString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="releaseDetail" class="grid cols-2">
      <div class="card stack">
        <h2>计划详情 / 操作</h2>
        <div class="row">
          <span :class="badge(releaseDetail.release.priority)">{{ releaseDetail.release.priority }}</span>
          <span :class="badge(releaseDetail.release.state)">{{ releaseDetail.release.state }}</span>
          <span class="muted">{{ releaseDetail.release.id }}</span>
        </div>
        <div class="row">
          <button :disabled="releaseDetail.release.state !== 'paused'" @click="action(api.approve)">批准 canary</button>
          <button class="secondary" @click="action(api.retry)">重试失败</button>
          <button class="secondary" :disabled="releaseDetail.release.priority !== 'normal'" @click="action(api.rollback)">普通回滚</button>
          <button class="danger" :disabled="releaseDetail.release.priority !== 'emergency'" @click="action(api.cancelEmergency)">取消紧急发布</button>
        </div>
        <p class="muted">紧急取消只把已成功节点逐节点恢复到接管前仍有效且域名匹配的证书；失败节点保留实际版本，旧计划不自动恢复。</p>
        <table>
          <thead><tr><th>节点</th><th>状态</th><th>接管前</th><th>当前实际</th><th>失败/原因</th></tr></thead>
          <tbody>
            <tr v-for="node in releaseDetail.nodes" :key="node.node_id">
              <td>{{ node.node_name }}</td>
              <td><span :class="badge(node.state)">{{ node.state }}</span></td>
              <td>{{ node.previous_cert_version ?? '—' }}</td>
              <td>{{ node.current_cert_version }}</td>
              <td class="muted">{{ node.failure_reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card stack">
        <h2>被替代原因 / 控制权历史</h2>
        <table>
          <thead><tr><th>节点</th><th>旧计划</th><th>恢复点</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="s in releaseDetail.supersessions" :key="s.id">
              <td>{{ s.node_id }}</td>
              <td class="muted">{{ s.superseded_release_id.slice(0, 8) }}</td>
              <td>{{ s.previous_cert_version ?? s.previous_cert_id ?? '当前实际' }}</td>
              <td>{{ s.reason }}</td>
            </tr>
            <tr v-if="!releaseDetail.supersessions.length"><td colspan="4" class="muted">无替代记录</td></tr>
          </tbody>
        </table>
        <h2>切换审计（不可覆盖）</h2>
        <pre>{{ releaseDetail.audit.map((a: any) => `${new Date(a.created_at).toLocaleTimeString()} ${a.event}: ${a.detail}`).join('\n') }}</pre>
      </div>
    </section>

    <section class="grid cols-2">
      <div class="card stack">
        <h2>节点证书切换记录</h2>
        <table>
          <thead><tr><th>时间</th><th>节点</th><th>类型</th><th>计划</th><th>从</th><th>到</th></tr></thead>
          <tbody>
            <tr v-for="event in snapshot?.events ?? []" :key="event.id">
              <td>{{ new Date(event.created_at).toLocaleTimeString() }}</td>
              <td>{{ event.node_id }}</td>
              <td><span :class="badge(event.kind)">{{ event.kind }}</span></td>
              <td class="muted">{{ event.release_id.slice(0, 8) }} g{{ event.generation }}</td>
              <td>{{ event.from_version ?? '—' }}</td>
              <td>{{ event.to_version ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card stack">
        <h2>迟到回执归属（只审计，不反写）</h2>
        <table>
          <thead><tr><th>时间</th><th>任务/计划</th><th>节点</th><th>回执</th><th>归属说明</th></tr></thead>
          <tbody>
            <tr v-for="receipt in snapshot?.lateReceipts ?? []" :key="receipt.task_id">
              <td>{{ new Date(receipt.received_at).toLocaleTimeString() }}</td>
              <td class="muted">{{ receipt.release_id.slice(0, 8) }} g{{ receipt.generation }}</td>
              <td>{{ receipt.node_id }}</td>
              <td><span :class="badge(receipt.success ? 'succeeded' : 'failed')">{{ receipt.success ? 'success' : 'fail' }}</span></td>
              <td>{{ receipt.rejection_reason }}</td>
            </tr>
            <tr v-if="!(snapshot?.lateReceipts?.length)"><td colspan="5" class="muted">暂无迟到回执</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
