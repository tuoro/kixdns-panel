<script setup lang="ts">
import { RouterView } from 'vue-router'
import ConfirmDialog from './components/ConfirmDialog.vue'
import SessionExpiredDialog from './components/SessionExpiredDialog.vue'
import ToastStack from './components/ToastStack.vue'
</script>

<template>
  <RouterView />
  <ConfirmDialog />
  <SessionExpiredDialog />
  <ToastStack />
</template>
