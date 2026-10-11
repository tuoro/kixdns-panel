<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ConnectionBoot from './components/ConnectionBoot.vue'
import SessionExpiredDialog from './components/SessionExpiredDialog.vue'
import ToastStack from './components/ToastStack.vue'
import { startConnectionWatch, stopConnectionWatch } from './composables/useConnection'

// 连不上面板的监听从一打开就在：启动时的会话读取也要靠它等面板回来 / Listening for an unreachable panel starts at once: the session read at start relies on it to wait for the panel
onMounted(startConnectionWatch)
onBeforeUnmount(stopConnectionWatch)
</script>

<template>
  <ConnectionBoot />
  <RouterView />
  <ConfirmDialog />
  <SessionExpiredDialog />
  <ToastStack />
</template>
