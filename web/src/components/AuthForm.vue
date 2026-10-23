<script setup lang="ts">
import { Clock, Eye, EyeOff, MonitorPlay, ShieldCheck, TriangleAlert } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '../composables/useSession'
import { errorMessage } from '../utils'
import BrandMark from './BrandMark.vue'

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
// 公开的在线演示里登录只是走个过场：说一句随便填就能进 / In the public online demo signing in is a formality: say that anything gets you in
const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true'
// 会话过期被送回来时说为什么；配置页上有没保存的修改时照实说丢了 / Sent back by an expired session: say why, and say plainly when unsaved config edits were lost
const expiredNote = computed(() => {
  if (isSetup.value || !route.query.expired) return ''
  return route.query.expired === 'draft' ? '刚才没保存的配置修改没有留下来。登录后回到刚才的页面。' : '登录后回到刚才的页面。'
})

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
      <div class="auth-brand"><BrandMark /><strong>KixDNS</strong></div>
      <div class="auth-heading">
        <h1>{{ isSetup ? '创建管理员' : '登录面板' }}</h1>
        <p v-if="isSetup">这个账号可以改配置、管服务、装更新。</p>
      </div>
      <!-- 会话过期被送回来：一条提示条说清，丢了没保存的修改时是醒目的黄色（这是读者最关心的一句），只是过期时是灰色
           Sent back by an expired session: a notice says so, amber when unsaved edits were lost (the sentence the reader cares about most), grey when it only expired -->
      <p v-if="expiredNote" class="ui-notice auth-expired" :class="{ 'ui-notice--off': route.query.expired !== 'draft' }" role="status"><component :is="route.query.expired === 'draft' ? TriangleAlert : Clock" :size="16" aria-hidden="true" /><span>登录已过期</span><small>{{ expiredNote }}</small></p>
      <p v-if="publicDemo && !isSetup" class="ui-notice ui-notice--off auth-demo" role="note"><MonitorPlay :size="16" aria-hidden="true" /><span>在线演示</span><small>用户名随便填三个字以上，密码随便填，就能进去看。</small></p>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" name="username" autocomplete="username" minlength="3" maxlength="64" required autofocus /></label>
        <label>密码
          <span class="password-field">
            <!-- 首次运行时把长度规则写进占位符：规则前置，而不是等提交后才报错。 -->
            <input v-model="password" name="password" :type="visible ? 'text' : 'password'" :placeholder="isSetup ? '至少 12 位' : undefined" :autocomplete="isSetup ? 'new-password' : 'current-password'" :minlength="isSetup ? 12 : 1" maxlength="256" required />
            <button type="button" :title="visible ? '隐藏密码' : '显示密码'" @click="visible = !visible"><EyeOff v-if="visible" :size="18" /><Eye v-else :size="18" /></button>
          </span>
        </label>
        <label v-if="isSetup">确认密码<input v-model="confirmation" name="confirmation" type="password" placeholder="再输入一次" autocomplete="new-password" minlength="12" maxlength="256" required /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="ui-btn ui-btn--primary auth-submit" type="submit" :disabled="submitting">
          <span>{{ submitting ? (isSetup ? '正在创建' : '正在验证') : isSetup ? '创建并进入' : '登录' }}</span>
        </button>
      </form>
      <!-- 首次运行的人心里有个没被回答的问题：我填完这个表，它会对我的 DNS 做什么。
           这块是静态文案，不含任何机器状态，所以不存在登录页那个暴露问题。 -->
      <div v-if="isSetup" class="auth-next">
        <p class="auth-next__promise">面板不会覆盖你已有的 KixDNS 配置。</p>
        <p>规则写好后要保存才会生效。</p>
      </div>
      <div class="auth-security">
        <ShieldCheck :size="14" />
        <span>
          密码不以明文保存，登录状态只留在这个<span class="nowrap">浏览器里。</span><template v-if="!isSetup">忘记密码时，在面板所在的机器上执行 <code>kixdns-panel-server reset-admin</code>，部署文档里有完整命令。</template>
        </span>
      </div>
    </section>
  </main>
</template>
