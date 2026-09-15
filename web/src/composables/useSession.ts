import { computed, readonly, ref } from 'vue'
import { ApiError, apiRequest, jsonBody, setCsrfToken } from '../api/client'
import type { AuthSession, SetupStatus, User } from '../api/types'

const user = ref<User | null>(null)
const setupRequired = ref(false)
const initialized = ref(false)
/**
 * 会话在页面还开着的时候过期了。
 *
 * 记住过期前是谁，好让重新验证只问密码——过期的是会话，不是「你是谁」。
 * 跳回登录页会把当前页整个卸载，配置草稿就此消失；那是这个面板上代价最大的
 * 一种数据丢失，而它完全可以避免，所以这里只是把状态标出来，由一层模态盖在
 * 原页上，背后的页面一直活着。
 *
 * The session expired while the page was still open. The previous user is kept
 * so re-authenticating only has to ask for the password: what expired is the
 * session, not who you are. Redirecting to the login page would unmount the
 * current page and take the config draft with it — the most expensive data loss
 * this panel can inflict, and an entirely avoidable one — so this only raises a
 * flag, and a modal covers the page while it stays mounted behind.
 */
const expiredFor = ref<User | null>(null)
let initialization: Promise<void> | null = null

function acceptSession(session: AuthSession): void {
  user.value = session.user
  setCsrfToken(session.csrf_token)
  expiredFor.value = null
}

async function initialize(): Promise<void> {
  if (initialized.value) return
  if (initialization) return initialization
  initialization = (async () => {
    const setup = await apiRequest<SetupStatus>('/api/v1/setup')
    setupRequired.value = setup.required
    if (!setup.required) {
      try {
        acceptSession(await apiRequest<AuthSession>('/api/v1/auth/session'))
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error
      }
    }
    initialized.value = true
  })().finally(() => {
    initialization = null
  })
  return initialization
}

async function authenticate(endpoint: '/api/v1/auth/login' | '/api/v1/setup', username: string, password: string): Promise<void> {
  acceptSession(await apiRequest<AuthSession>(endpoint, {
    method: 'POST',
    ...jsonBody({ username, password }),
  }))
  setupRequired.value = false
}

async function logout(): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' })
  expire()
  expiredFor.value = null
}

function expire(): void {
  user.value = null
  setCsrfToken('')
}

/** 标记会话已过期，并记住过期前是谁。已经标记过就不重复，避免并发 401 连环触发。 */
function markExpired(): void {
  if (expiredFor.value) return
  expiredFor.value = user.value
  expire()
}

/** 用户在模态里选择彻底退出：清掉过期标记，让路由守卫把人送去登录页。 */
function abandonExpiredSession(): void {
  expiredFor.value = null
}

export function useSession() {
  return {
    user: readonly(user),
    setupRequired: readonly(setupRequired),
    authenticated: computed(() => user.value !== null),
    initialize,
    login: (username: string, password: string) => authenticate('/api/v1/auth/login', username, password),
    setup: (username: string, password: string) => authenticate('/api/v1/setup', username, password),
    logout,
    expire,
    expiredFor: readonly(expiredFor),
    expired: computed(() => expiredFor.value !== null),
    markExpired,
    abandonExpiredSession,
  }
}
