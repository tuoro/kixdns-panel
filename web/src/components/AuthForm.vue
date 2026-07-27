<script setup lang="ts">
import { Activity, ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '../composables/useSession'
import { errorMessage } from '../utils'

const props = defineProps<{ mode: 'login' | 'setup' }>()
const route = useRoute()
const router = useRouter()
const session = useSession()
const username = ref('')
const password = ref('')
const confirmation = ref('')
const visible = ref(false)
const submitting = ref(false)
const error = ref('')
const isSetup = computed(() => props.mode === 'setup')

async function submit(): Promise<void> {
  error.value = ''
  if (isSetup.value && password.value !== confirmation.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  submitting.value = true
  try {
    if (isSetup.value) await session.setup(username.value, password.value)
    else await session.login(username.value, password.value)
    const requested = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.replace(requested.startsWith('/') ? requested : '/')
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="auth-brand"><span><Activity :size="22" /></span><strong>KixDNS</strong></div>
      <div class="auth-heading">
        <p class="eyebrow">{{ isSetup ? '首次运行' : '安全访问' }}</p>
        <h1>{{ isSetup ? '创建管理员' : '登录控制台' }}</h1>
        <p>{{ isSetup ? '此账号将拥有配置、服务与更新权限。' : '使用管理员凭据继续。' }}</p>
      </div>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" name="username" autocomplete="username" minlength="3" maxlength="64" required autofocus /></label>
        <label>密码
          <span class="password-field">
            <input v-model="password" name="password" :type="visible ? 'text' : 'password'" :autocomplete="isSetup ? 'new-password' : 'current-password'" :minlength="isSetup ? 12 : 1" maxlength="256" required />
            <button type="button" :title="visible ? '隐藏密码' : '显示密码'" @click="visible = !visible"><EyeOff v-if="visible" :size="18" /><Eye v-else :size="18" /></button>
          </span>
        </label>
        <label v-if="isSetup">确认密码<input v-model="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="256" required /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="button button--primary auth-submit" type="submit" :disabled="submitting">
          <span>{{ submitting ? '正在验证' : isSetup ? '创建并进入' : '登录' }}</span><ArrowRight :size="18" />
        </button>
      </form>
      <div class="auth-security"><ShieldCheck :size="17" /><span>凭据使用 Argon2id 加密，会话仅保存在 HttpOnly Cookie</span></div>
    </section>
    <aside class="auth-status">
      <div class="auth-status__signal"><i></i><span>Enhanced Control</span></div>
      <blockquote>把运行状态、配置变更与二进制更新放在同一个可审计的控制面。</blockquote>
      <dl><div><dt>控制协议</dt><dd>v1</dd></div><div><dt>会话保护</dt><dd>CSRF + SameSite</dd></div><div><dt>更新通道</dt><dd>Verified Action</dd></div></dl>
    </aside>
  </main>
</template>
