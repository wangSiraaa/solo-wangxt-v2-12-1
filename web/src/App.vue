<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">🔐 证书发布平台</div>
      <nav>
        <RouterLink to="/releases">发布计划</RouterLink>
        <RouterLink to="/nodes">节点</RouterLink>
        <RouterLink to="/certs">证书</RouterLink>
        <RouterLink to="/receipts">回执审计</RouterLink>
      </nav>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>
