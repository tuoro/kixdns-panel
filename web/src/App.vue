<script setup lang="ts">
import { RouterView } from 'vue-router'
import SessionExpiredDialog from './components/SessionExpiredDialog.vue'
import ToastStack from './components/ToastStack.vue'
</script>

<template>
  <RouterView />
  <SessionExpiredDialog />
  <ToastStack />
</template>
