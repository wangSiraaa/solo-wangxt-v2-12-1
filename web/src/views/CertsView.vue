<template>
  <section>
    <div class="page-head">
      <h2>证书</h2>
      <button class="primary" @click="showCreate = true">+ 录入证书</button>
    </div>
    <table class="grid">
      <thead>
        <tr><th>域名</th><th>版本</th><th>状态</th><th>生效</th><th>过期</th><th>录入时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in certs" :key="c.id">
          <td>{{ c.domain }}</td>
          <td>v{{ c.version }}</td>
          <td><span class="status" :class="c.status">{{ c.status === 'valid' ? '有效' : '已吊销' }}</span></td>
          <td>{{ fmtTime(c.not_before) }}</td>
          <td>{{ fmtTime(c.not_after) }}</td>
          <td>{{ fmtTime(c.created_at) }}</td>
          <td>
            <button v-if="c.status === 'valid'" class="btn-link" @click="revoke(c)">吊销</button>
          </td>
        </tr>
        <tr v-if="!certs.length"><td colspan="7" class="empty">暂无证书</td></tr>
      </tbody>
    </table>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>录入证书</h3>
        <label>域名 <input v-model="form.domain" placeholder="api.example.com" /></label>
        <label>版本 <input type="number" v-model.number="form.version" min="1" /></label>
        <label>内容 <textarea v-model="form.content" rows="3" placeholder="PEM / 指纹"></textarea></label>
        <label>有效期(天) <input type="number" v-model.number="form.days" min="1" /></label>
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
import { api, fmtTime } from '../api';

const certs = ref([]);
const showCreate = ref(false);
const error = ref('');
const form = reactive({ domain: '', version: 1, content: '', days: 30 });

async function load() {
  certs.value = await api.listCerts();
}

async function create() {
  error.value = '';
  try {
    await api.createCert({
      domain: form.domain,
      version: form.version,
      content: form.content || `cert-${form.domain}-v${form.version}`,
      notBefore: new Date().toISOString(),
      notAfter: new Date(Date.now() + form.days * 86400_000).toISOString(),
    });
    showCreate.value = false;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function revoke(c) {
  if (window.confirm(`确认吊销 ${c.domain} v${c.version}？`)) {
    await api.revokeCert(c.id);
    await load();
  }
}

onMounted(load);
</script>
