import { ref } from 'vue'
import { apiRequest, isPanelDown } from '../api/client'
import type { ConfigDocument, ServiceStatus } from '../api/types'
import { errorMessage } from '../utils'
import { useSession } from './useSession'
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

// 在说「改过的设置要重启才生效」的地方直接重启 KixDNS（配置页），确认由调用方先问。重启接口在 systemd 接手后就返回，KixDNS 读完配置、
// 控制通道连上还要一会儿：等它回来（半秒看一次，最多等十五秒）才说「已重启」，一个绑不上新地址、起不来的 KixDNS 不被说成重启好了。
// 等的时候面板自己连不上了（顶上的横幅会说）、或者退出登录了，就不再说 KixDNS 怎么样。回来了返回 true；重启没成、或者等不到它回来，返回 false
// Restart KixDNS right where a page says changed settings take a restart (the config page); the caller asks for confirmation first.
// The restart call returns once systemd takes over, and KixDNS needs a moment to read its config and open the control channel: it
// waits for it to come back (looking every half second, fifteen seconds at most) before saying 已重启, so a KixDNS that cannot bind a
// new address and never starts is not reported as restarted. If the panel itself goes unreachable meanwhile (the banner says so) or the
// session ends, nothing more is said about KixDNS. Returns true once it is back; false when the restart failed or it did not come back
export function useServiceRestart() {
  const toast = useToast()
  const session = useSession()
  const restarting = ref(false)
  async function restart(): Promise<boolean> {
    if (restarting.value) return false
    restarting.value = true
    try {
      await apiRequest<ServiceStatus>('/api/v1/service/restart', { method: 'POST' })
      const deadline = Date.now() + 15_000
      let panelDown = false
      while (Date.now() < deadline) {
        // 只看最近一次：面板断开过又连上，照常等 KixDNS / Only the latest read counts: a panel that dropped and came back waits for KixDNS as usual
        const status = await apiRequest<ConfigDocument>('/api/v1/config').then((doc) => {
          panelDown = false
          return doc.runtime.status
        }, (error: unknown) => {
          panelDown = isPanelDown(error)
          return null
        })
        if (!session.authenticated.value) return false
        if (status !== null && status !== 'unavailable') {
          toast.success('KixDNS 服务已重启')
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!panelDown) toast.error('KixDNS 重启后没有回应，查看日志了解原因')
      return false
    } catch (error) {
      toast.error(errorMessage(error))
      return false
    } finally {
      restarting.value = false
    }
  }
  return { restarting, restart }
}
