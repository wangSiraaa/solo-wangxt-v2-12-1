import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import ReleasesView from './views/ReleasesView.vue';
import ReleaseDetailView from './views/ReleaseDetailView.vue';
import NodesView from './views/NodesView.vue';
import CertsView from './views/CertsView.vue';
import ReceiptsView from './views/ReceiptsView.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/releases' },
    { path: '/releases', component: ReleasesView },
    { path: '/releases/:id', component: ReleaseDetailView, props: true },
    { path: '/nodes', component: NodesView },
    { path: '/certs', component: CertsView },
    { path: '/receipts', component: ReceiptsView },
  ],
});

createApp(App).use(router).mount('#app');
