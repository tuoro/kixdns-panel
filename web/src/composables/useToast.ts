import { readonly, ref } from 'vue'

export interface ToastMessage {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

const messages = ref<ToastMessage[]>([])
let sequence = 0

function dismiss(id: number): void {
  messages.value = messages.value.filter((message) => message.id !== id)
}

function push(message: string, kind: ToastMessage['kind'] = 'info'): void {
  const id = ++sequence
  messages.value.push({ id, kind, message })
  window.setTimeout(() => dismiss(id), 4500)
}

export function useToast() {
  return {
    messages: readonly(messages),
    dismiss,
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error'),
    info: (message: string) => push(message, 'info'),
  }
}
