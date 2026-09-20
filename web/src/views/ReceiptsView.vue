<template>
  <section>
    <div class="page-head">
      <h2>回执审计</h2>
      <label class="filter">
        <input type="checkbox" v-model="lateOnly" @change="load" /> 只看迟到回执
      </label>
    </div>
    <table class="grid">
      <thead>
        <tr>
          <th>时间</th><th>节点</th><th>归属计划</th><th>代次</th><th>结果</th>
          <th>采纳</th><th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in receipts" :key="r.id" :class="{ late: r.late }">
          <td>{{ fmtTime(r.received_at) }}</td>
          <td>{{ r.node_name || '-' }}</td>
          <td>
            <RouterLink v-if="r.release_id" :to="`/releases/${r.release_id}`">{{ r.release_name || r.release_id.slice(0, 8) }}</RouterLink>
            <span v-else>(未知)</span>
          </td>
          <td>{{ r.epoch ?? '-' }}</td>
          <td>
            {{ r.outcome === 'success' ? '成功' : '失败' }}
            <span v-if="r.late" class="tag late">迟到</span>
          </td>
          <td>{{ r.applied ? '是' : '否' }}</td>
          <td class="reason">{{ r.note }}</td>
        </tr>
        <tr v-if="!receipts.length"><td colspan="7" class="empty">暂无回执</td></tr>
      </tbody>
    </table>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api, fmtTime } from '../api';

const receipts = ref([]);
const lateOnly = ref(false);

async function load() {
  receipts.value = await api.listReceipts(lateOnly.value ? { late: 'true' } : {});
}

onMounted(load);
</script>
