import { ref } from 'vue'
import { apiRequest } from '../api/client'
import type { ServiceStatus } from '../api/types'
import { errorMessage } from '../utils'
import { useToast } from './useToast'

// 在说 KixDNS 停着的地方直接启动它（概览、配置页头、诊断），不用先去系统页。成功返回新的服务状态，失败给出原因并返回 null。
// Start KixDNS right where a page says it is stopped (overview, config header, diagnostics) without a trip to the system page.
// Returns the new service status on success; on failure it says why and returns null.
export function useServiceStart() {
  const toast = useToast()
  const starting = ref(false)
  async function start(): Promise<ServiceStatus | null> {
    if (starting.value) return null
    starting.value = true
    try {
      const status = await apiRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
      toast.success('KixDNS 服务已启动')
      return status
    } catch (error) {
      toast.error(errorMessage(error))
      return null
    } finally {
      starting.value = false
    }
  }
  return { starting, start }
}
