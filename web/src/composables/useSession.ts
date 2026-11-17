import { computed, readonly, ref } from 'vue'
import { ApiError, apiRequest, jsonBody } from '../api/client'
import type { AuthSession, SetupStatus, User } from '../api/types'

const user = ref<User | null>(null)
const setupRequired = ref(false)
const initialized = ref(false)
let initialization: Promise<void> | null = null

// CSRF 令牌不在这里记：写请求发出时从 Cookie 里读（见 api/client） / The CSRF token is not kept here: writes read it from the cookie when sent (see api/client)
function acceptSession(session: AuthSession): void {
  user.value = session.user
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
}

function expire(): void {
  user.value = null
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
  }
}
