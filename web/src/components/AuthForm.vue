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
const isSetup = computed(() => props.mode === 'setup')
// 公开的在线演示里登录只是走个过场：账号密码预先填好，点登录就进；不把光标放进用户名框，免得像是要人重填
// In the public online demo signing in is a formality: the fields come filled in, so 登录 gets you in; the username field takes no
// autofocus, which would read as asking for it to be retyped
const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true'
const demoSignIn = publicDemo && !isSetup.value
const username = ref(demoSignIn ? 'admin' : '')
const password = ref(demoSignIn ? 'demo' : '')
const confirmation = ref('')
const visible = ref(false)
const submitting = ref(false)
const error = ref('')
// 会话过期被送回来时说为什么；配置页上有没保存的修改时照实说丢了 / Sent back by an expired session: say why, and say plainly when unsaved config edits were lost
// 草稿可能丢了（没保存的、不知道存上没有的）：和别处一样用黄底三角 / The draft may be lost (unsaved, or a save not known to have landed):
// the yellow triangle, as elsewhere
const draftLost = computed(() => route.query.expired === 'draft' || route.query.expired === 'unknown')
const expiredNote = computed((): string[] => {
  if (isSetup.value || !route.query.expired) return []
  // unknown：那份修改是一次回应丢了、还没核对的保存，存没存上不知道 / unknown: those edits were a save whose answer was lost and never checked
  // 「配置保存」后面能断：一长串中文按词换行时没有断点，窄屏上会从词中间硬切 / A break may fall after 配置保存: a long CJK run under keep-all has
  // no break point and is cut mid-word on narrow screens
  if (route.query.expired === 'unknown') return ['刚才那次配置保存', '不知道存上没有，没存上的修改没有留下来。登录后回到刚才的页面。']
  return [route.query.expired === 'draft' ? '刚才没保存的配置修改没有留下来。登录后回到刚才的页面。' : '登录后回到刚才的页面。']
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
      <p v-if="expiredNote.length" class="ui-notice auth-expired" :class="{ 'ui-notice--off': !draftLost }" role="status"><component :is="draftLost ? TriangleAlert : Clock" :size="16" aria-hidden="true" /><span>登录已过期</span><small><template v-for="(part, k) in expiredNote" :key="k"><wbr v-if="k">{{ part }}</template></small></p>
      <p v-if="demoSignIn" class="ui-notice ui-notice--off auth-demo" role="note"><MonitorPlay :size="16" aria-hidden="true" /><span>在线演示</span><small>演示账号已填好，直接登录即可。</small></p>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" name="username" autocomplete="username" minlength="3" maxlength="64" required :autofocus="!demoSignIn" /></label>
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
