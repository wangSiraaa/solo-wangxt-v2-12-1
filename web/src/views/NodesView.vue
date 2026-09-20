<template>
  <section>
    <div class="page-head">
      <h2>节点</h2>
      <button class="primary" @click="showCreate = true">+ 接入节点</button>
    </div>

    <table class="grid">
      <thead>
        <tr>
          <th>节点</th><th>域名</th><th>当前证书</th><th>当前控制计划</th><th>代次</th>
          <th>迟到回执</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="n in nodes" :key="n.id">
          <td>{{ n.name }}</td>
          <td>{{ (n.domains || []).join(', ') }}</td>
          <td>v{{ n.current_cert_version ?? '-' }}</td>
          <td>
            <RouterLink v-if="n.controlling_release_id" :to="`/releases/${n.controlling_release_id}`">
              {{ n.controlling_release_name }}
            </RouterLink>
            <small v-if="n.controlling_release_id">
              ({{ n.controlling_release_kind === 'emergency' ? '紧急' : '普通' }} / {{ statusText(n.controlling_release_status) }})
            </small>
            <span v-else>-</span>
          </td>
          <td>{{ n.control_epoch ?? '-' }}</td>
          <td>
            <span v-if="n.late_receipt_count" class="tag late">{{ n.late_receipt_count }} 条</span>
            <span v-else>-</span>
          </td>
          <td><button class="btn-link" @click="open(n.id)">详情</button></td>
        </tr>
        <tr v-if="!nodes.length"><td colspan="7" class="empty">暂无节点</td></tr>
      </tbody>
    </table>

    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal wide">
        <h3>{{ detail.name }} — 控制与回执</h3>
        <p>
          当前证书: v{{ detail.current_cert_version ?? '-' }} ｜ 控制计划:
          <template v-if="detail.control">
            {{ detail.control.release_name }}（代次 {{ detail.control.epoch }}）
          </template>
          <template v-else>无</template>
        </p>
        <h4>切换历史</h4>
        <table class="grid">
          <thead><tr><th>时间</th><th>从</th><th>到</th><th>代次</th><th>原因</th><th>操作者</th></tr></thead>
          <tbody>
            <tr v-for="s in detail.switches" :key="s.id">
              <td>{{ fmtTime(s.created_at) }}</td>
              <td>{{ s.from_release_name || '(无)' }}</td>
              <td>{{ s.to_release_name }}</td>
              <td>{{ s.from_epoch }} → {{ s.to_epoch }}</td>
              <td>{{ s.reason === 'emergency_takeover' ? '紧急接管' : '常规调度' }}</td>
              <td>{{ s.operator }}</td>
            </tr>
            <tr v-if="!detail.switches.length"><td colspan="6" class="empty">暂无</td></tr>
          </tbody>
        </table>
        <h4>回执（迟到回执标注归属）</h4>
        <table class="grid">
          <thead><tr><th>时间</th><th>归属计划</th><th>代次</th><th>结果</th><th>采纳</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="r in detail.receipts" :key="r.id" :class="{ late: r.late }">
              <td>{{ fmtTime(r.received_at) }}</td>
              <td>{{ r.release_name || '(未知)' }}</td>
              <td>{{ r.epoch ?? '-' }}</td>
              <td>{{ r.outcome === 'success' ? '成功' : '失败' }}<span v-if="r.late" class="tag late">迟到</span></td>
              <td>{{ r.applied ? '是' : '否' }}</td>
              <td class="reason">{{ r.note }}</td>
            </tr>
            <tr v-if="!detail.receipts.length"><td colspan="6" class="empty">暂无</td></tr>
          </tbody>
        </table>
        <div class="modal-actions"><button @click="detail = null">关闭</button></div>
      </div>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>接入节点</h3>
        <label>名称 <input v-model="form.name" placeholder="node-1" /></label>
        <label>域名（逗号分隔） <input v-model="form.domains" placeholder="api.example.com" /></label>
        <label>初始证书
          <select v-model="form.certId">
            <option value="">无</option>
            <option v-for="c in certs" :key="c.id" :value="c.id">{{ c.domain }} v{{ c.version }}</option>
          </select>
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="modal-actions">
          <button @click="showCreate = false">取消</button>
          <button class="primary" @click="create">创建</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api, RELEASE_STATUS, fmtTime } from '../api';

const nodes = ref([]);
const certs = ref([]);
const detail = ref(null);
const showCreate = ref(false);
const error = ref('');
const form = reactive({ name: '', domains: '', certId: '' });

const statusText = (s) => RELEASE_STATUS[s] || s;

async function load() {
  [nodes.value, certs.value] = await Promise.all([api.listNodes(), api.listCerts()]);
}

async function open(id) {
  detail.value = await api.nodeDetail(id);
}

async function create() {
  error.value = '';
  try {
    const cert = certs.value.find((c) => c.id === form.certId);
    await api.createNode({
      name: form.name,
      domains: form.domains.split(',').map((s) => s.trim()).filter(Boolean),
      currentCertId: cert?.id,
      currentCertVersion: cert?.version,
    });
    showCreate.value = false;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
</script>
