<template>
  <section v-if="rel">
    <div class="page-head">
      <div>
        <h2>
          <span class="tag" :class="rel.kind">{{ rel.kind === 'emergency' ? '紧急' : '普通' }}</span>
          {{ rel.name }}
          <small class="prio">优先级 {{ rel.priority }}</small>
        </h2>
        <div class="subhead">
          <span class="status" :class="rel.status">{{ statusText(rel.status) }}</span>
          <span v-if="rel.state_reason" class="state-reason">{{ rel.state_reason }}</span>
        </div>
      </div>
      <div class="actions">
        <button v-if="rel.status === 'draft' && rel.kind === 'normal'" class="primary" @click="act(api.startRelease)">启动</button>
        <button v-if="rel.status === 'draft' && rel.kind === 'emergency'" class="danger" @click="openPreview">预览冲突并接管</button>
        <button v-if="rel.status === 'gate_paused'" class="primary" @click="act(api.promote)">通过灰度门</button>
        <button v-if="rel.status === 'running'" @click="act(api.pause)">暂停</button>
        <button v-if="rel.status === 'paused'" class="primary" @click="act(api.resume)">恢复</button>
        <button v-if="rel.status === 'failed'" class="primary" @click="act(api.retry)">重试失败节点</button>
        <button v-if="['completed','failed','running','gate_paused','paused'].includes(rel.status)" @click="confirmDo('确认整体回滚？', () => act(api.rollback))">回滚</button>
        <button v-if="['running','gate_paused','paused','failed','rolling_back'].includes(rel.status)" class="danger" @click="cancelRelease">取消发布</button>
      </div>
    </div>

    <p v-if="actionError" class="error">{{ actionError }}</p>

    <!-- 接管冲突预览 + 人工确认 -->
    <div v-if="preview" class="preview-box">
      <h3>接管冲突预览（{{ preview.conflicts }} 个节点存在现有控制方）</h3>
      <table class="grid">
        <thead>
          <tr><th>节点</th><th>当前证书</th><th>当前控制计划</th><th>其状态</th><th>其任务</th><th>在途请求</th><th>接管动作</th></tr>
        </thead>
        <tbody>
          <tr v-for="n in preview.nodes" :key="n.nodeId">
            <td>{{ n.nodeName }}</td>
            <td>v{{ n.currentCertVersion ?? '-' }}</td>
            <td>
              <span v-if="n.controlledBy">
                {{ n.controlledBy.releaseName }}
                <small>({{ n.controlledBy.kind === 'emergency' ? '紧急' : '普通' }} / 优先级 {{ n.controlledBy.priority }} / 代次 {{ n.controlledBy.epoch }})</small>
              </span>
              <span v-else>-</span>
            </td>
            <td>{{ n.controlledBy ? statusText(n.controlledBy.status) : '-' }}</td>
            <td>{{ n.controllerTaskStatus ? taskText(n.controllerTaskStatus) : '-' }}</td>
            <td>{{ n.inFlightRequests }}</td>
            <td>
              <span class="tag" :class="n.action">{{ actionText(n.action) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="modal-actions">
        <button @click="preview = null">再想想</button>
        <button class="danger" :disabled="confirming" @click="confirmTakeover">
          {{ confirming ? '接管中…' : '确认接管（原子转移控制权）' }}
        </button>
      </div>
    </div>

    <h3>节点任务</h3>
    <table class="grid">
      <thead>
        <tr><th>节点</th><th>状态</th><th>代次</th><th>尝试</th><th>节点当前证书</th><th>错误 / 说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="t in rel.tasks" :key="t.id">
          <td>{{ t.node_name }}</td>
          <td><span class="status" :class="t.status">{{ taskText(t.status) }}</span></td>
          <td>{{ t.epoch }}</td>
          <td>{{ t.attempts }}/{{ t.max_attempts }}</td>
          <td>v{{ t.node_cert_version ?? '-' }}</td>
          <td class="reason">{{ t.last_error || t.note || '-' }}</td>
        </tr>
      </tbody>
    </table>

    <div class="cols">
      <div>
        <h3>控制权切换记录</h3>
        <table class="grid">
          <thead><tr><th>时间</th><th>节点</th><th>从</th><th>到</th><th>代次</th><th>原因</th><th>操作者</th></tr></thead>
          <tbody>
            <tr v-for="s in rel.switches" :key="s.id">
              <td>{{ fmtTime(s.created_at) }}</td>
              <td>{{ nodeName(s.node_id) }}</td>
              <td>{{ s.from_release_name || '(无)' }}</td>
              <td>{{ s.to_release_name }}</td>
              <td>{{ s.from_epoch }} → {{ s.to_epoch }}</td>
              <td>{{ s.reason === 'emergency_takeover' ? '紧急接管' : '常规调度' }}</td>
              <td>{{ s.operator }}</td>
            </tr>
            <tr v-if="!rel.switches.length"><td colspan="7" class="empty">暂无</td></tr>
          </tbody>
        </table>
      </div>
      <div>
        <h3>回执（含迟到回执归属）</h3>
        <table class="grid">
          <thead><tr><th>时间</th><th>节点</th><th>归属计划</th><th>结果</th><th>采纳</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="r in rel.receipts" :key="r.id" :class="{ late: r.late }">
              <td>{{ fmtTime(r.received_at) }}</td>
              <td>{{ r.node_name || '-' }}</td>
              <td>{{ r.release_name || '(未知)' }}</td>
              <td>{{ r.outcome === 'success' ? '成功' : '失败' }}<span v-if="r.late" class="tag late">迟到</span></td>
              <td>{{ r.applied ? '是' : '否' }}</td>
              <td class="reason">{{ r.note }}</td>
            </tr>
            <tr v-if="!rel.receipts.length"><td colspan="6" class="empty">暂无</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, RELEASE_STATUS, TASK_STATUS, fmtTime } from '../api';

const props = defineProps({ id: String });
const rel = ref(null);
const preview = ref(null);
const confirming = ref(false);
const actionError = ref('');
let timer = null;

const statusText = (s) => RELEASE_STATUS[s] || s;
const taskText = (s) => TASK_STATUS[s] || s;
const actionText = (a) => ({ claim: '直接接管(空闲)', takeover: '接管(中断旧计划)', adopt: '沿用(已成功不覆盖)' }[a] || a);
const nodeName = (id) => rel.value?.tasks.find((t) => t.node_id === id)?.node_name || id?.slice(0, 8);

async function load() {
  rel.value = await api.releaseDetail(props.id);
}

async function act(fn) {
  actionError.value = '';
  try {
    await fn(props.id, 'web-operator');
    await load();
  } catch (e) {
    actionError.value = e.message;
  }
}

async function openPreview() {
  actionError.value = '';
  try {
    preview.value = await api.takeoverPreview(props.id);
  } catch (e) {
    actionError.value = e.message;
  }
}

async function confirmTakeover() {
  confirming.value = true;
  actionError.value = '';
  try {
    await api.confirmTakeover(props.id, 'web-operator');
    preview.value = null;
    await load();
  } catch (e) {
    actionError.value = e.message;
  } finally {
    confirming.value = false;
  }
}

function confirmDo(msg, fn) {
  if (window.confirm(msg)) fn();
}

function cancelRelease() {
  const reason = window.prompt('取消原因（紧急发布将把成功节点恢复到接管前证书）:', '人工取消');
  if (reason !== null) act((id) => api.cancel(id, reason));
}

onMounted(() => {
  load();
  timer = setInterval(load, 2000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
