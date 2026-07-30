import { computed, readonly, ref } from 'vue'
import { apiRequest } from '../api/client'
import type { UpdateNotifications } from '../api/types'
import { errorMessage } from '../utils'

const status = ref<UpdateNotifications | null>(null)
const checking = ref(false)
const error = ref('')
let pending: Promise<void> | null = null

const availableCount = computed(() => {
  if (!status.value) return 0
  return Number(status.value.kixdns.available) + Number(status.value.panel.available)
})

function refresh(): Promise<void> {
  if (pending) return pending
  checking.value = true
  pending = apiRequest<UpdateNotifications>('/api/v1/updates/status')
    .then((next) => {
      status.value = next
      error.value = ''
    })
    .catch((caught: unknown) => {
      error.value = errorMessage(caught)
    })
    .finally(() => {
      checking.value = false
      pending = null
    })
  return pending
}

export function useUpdateStatus() {
  return {
    status: readonly(status),
    checking: readonly(checking),
    error: readonly(error),
    availableCount,
    refresh,
  }
}
