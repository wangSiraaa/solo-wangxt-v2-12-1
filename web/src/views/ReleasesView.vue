<template>
  <section>
    <div class="page-head">
      <h2>发布计划</h2>
      <button class="primary" @click="showCreate = true">+ 新建发布</button>
    </div>

    <table class="grid">
      <thead>
        <tr>
          <th>名称</th><th>类型</th><th>优先级</th><th>状态</th><th>进度</th>
          <th>被替代原因 / 状态说明</th><th>创建时间</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in releases" :key="r.id" :class="{ emergency: r.kind === 'emergency' }">
          <td>
            <RouterLink :to="`/releases/${r.id}`">{{ r.name }}</RouterLink>
          </td>
          <td>
            <span class="tag" :class="r.kind">{{ r.kind === 'emergency' ? '紧急' : '普通' }}</span>
          </td>
          <td>{{ r.priority }}</td>
          <td><span class="status" :class="r.status">{{ statusText(r.status) }}</span></td>
          <td>{{ r.done_count }}/{{ r.task_count }}
            <span v-if="r.failed_count" class="fail-count">({{ r.failed_count }} 失败)</span>
          </td>
          <td class="reason">
            <span v-if="r.status === 'superseded'">
              {{ r.state_reason }}
              <RouterLink v-if="r.superseded_by_release_id" :to="`/releases/${r.superseded_by_release_id}`">
                {{ r.superseded_by_name || '接管计划' }}
              </RouterLink>
            </span>
            <span v-else>{{ r.state_reason || '-' }}</span>
          </td>
          <td>{{ fmtTime(r.created_at) }}</td>
          <td><RouterLink class="btn-link" :to="`/releases/${r.id}`">详情</RouterLink></td>
        </tr>
        <tr v-if="!releases.length"><td colspan="8" class="empty">暂无发布计划</td></tr>
      </tbody>
    </table>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>新建发布计划</h3>
        <label>名称 <input v-model="form.name" placeholder="如：常规轮换-9月" /></label>
        <label>类型
          <select v-model="form.kind">
            <option value="normal">普通（灰度门 + 分批）</option>
            <option value="emergency">紧急（高优先级，可接管）</option>
          </select>
        </label>
        <label>目标证书
          <select v-model="form.certId">
            <option disabled value="">选择证书</option>
            <option v-for="c in certs" :key="c.id" :value="c.id">
              {{ c.domain }} v{{ c.version }} ({{ c.status }})
            </option>
          </select>
        </label>
        <label>优先级 <input type="number" v-model.number="form.priority" :placeholder="form.kind === 'emergency' ? '100' : '10'" /></label>
        <fieldset>
          <legend>目标节点（{{ form.nodeIds.length }} 已选）</legend>
          <div class="node-picks">
            <label v-for="n in nodes" :key="n.id" class="pick">
              <input type="checkbox" :value="n.id" v-model="form.nodeIds" />
              {{ n.name }} <small>v{{ n.current_cert_version ?? '-' }}</small>
            </label>
          </div>
        </fieldset>
        <template v-if="form.kind === 'normal'">
          <label>金丝雀比例 % <input type="number" v-model.number="form.canaryPercent" min="1" max="100" /></label>
          <label>每批节点数 <input type="number" v-model.number="form.batchSize" min="1" /></label>
        </template>
        <label>请求超时(ms) <input type="number" v-model.number="form.dispatchTimeoutMs" min="100" /></label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="modal-actions">
          <button @click="showCreate = false">取消</button>
          <button class="primary" :disabled="creating" @click="create">
            {{ creating ? '创建中…' : (form.kind === 'emergency' ? '创建（待接管确认）' : '创建') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, RELEASE_STATUS, fmtTime } from '../api';

const router = useRouter();
const releases = ref([]);
const certs = ref([]);
const nodes = ref([]);
const showCreate = ref(false);
const creating = ref(false);
const error = ref('');
const form = reactive({
  name: '', kind: 'normal', certId: '', priority: null, nodeIds: [],
  canaryPercent: 25, batchSize: 2, dispatchTimeoutMs: 3000,
});

const statusText = (s) => RELEASE_STATUS[s] || s;

async function load() {
  [releases.value, certs.value, nodes.value] = await Promise.all([
    api.listReleases(), api.listCerts(), api.listNodes(),
  ]);
}

async function create() {
  error.value = '';
  if (!form.name || !form.certId || !form.nodeIds.length) {
    error.value = '名称、证书和至少一个节点必填';
    return;
  }
  creating.value = true;
  try {
    const rel = await api.createRelease({
      name: form.name,
      kind: form.kind,
      certId: form.certId,
      nodeIds: form.nodeIds,
      priority: form.priority ?? undefined,
      strategy: {
        canaryPercent: form.canaryPercent,
        batchSize: form.batchSize,
        dispatchTimeoutMs: form.dispatchTimeoutMs,
        maxAttempts: 3,
      },
      createdBy: 'web-operator',
    });
    showCreate.value = false;
    router.push(`/releases/${rel.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>
