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
  return Number(status.value.kixdns?.available ?? false) + Number(status.value.panel?.available ?? false)
})

// 每次检查编一个号，只收最新那次的：更新内核、换 Token 之后要的是那以后的结果，必须重新发（fresh），之前发出的那次晚回来也不盖掉
// Each check gets a number and only the latest is kept: after a kernel update or a token change the result must come from after it, so
// a new check is sent (fresh) and one sent before cannot overwrite it when it lands late
let request = 0
function refresh(fresh = false): Promise<void> {
  if (pending && !fresh) return pending
  checking.value = true
  const mine = ++request
  pending = apiRequest<UpdateNotifications>('/api/v1/updates/status')
    .then((next) => {
      if (mine !== request) return
      status.value = next
      error.value = ''
    })
    .catch((caught: unknown) => {
      if (mine === request) error.value = errorMessage(caught)
    })
    .finally(() => {
      if (mine !== request) return
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
