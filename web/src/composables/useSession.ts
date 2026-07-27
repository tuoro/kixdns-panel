import { computed, readonly, ref } from 'vue'
import { ApiError, apiRequest, jsonBody, setCsrfToken } from '../api/client'
import type { AuthSession, SetupStatus, User } from '../api/types'

const user = ref<User | null>(null)
const setupRequired = ref(false)
const initialized = ref(false)
let initialization: Promise<void> | null = null

function acceptSession(session: AuthSession): void {
  user.value = session.user
  setCsrfToken(session.csrf_token)
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
  setCsrfToken('')
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
