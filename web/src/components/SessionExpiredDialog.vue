<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSession } from '../composables/useSession'
import { errorMessage } from '../utils'

const session = useSession()
const router = useRouter()
const password = ref('')
const error = ref('')
const submitting = ref(false)
const passwordInput = ref<HTMLInputElement | null>(null)

watch(() => session.expired.value, async (expired) => {
  if (!expired) return
  password.value = ''
  error.value = ''
  await nextTick()
  passwordInput.value?.focus()
})

async function submit(): Promise<void> {
  if (submitting.value || !password.value) return
  submitting.value = true
  error.value = ''
  try {
    await session.login(session.expiredFor.value?.username ?? '', password.value)
    password.value = ''
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    submitting.value = false
  }
}

// 这是这个框里唯一真会丢东西的选项，所以做次要样式、放在下面。
function leave(): void {
  session.abandonExpiredSession()
  void router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
}
</script>

<template>
  <!--
    盖在当前页之上，不跳转。背后的页面一直挂载着，配置草稿原样留着，
    验证通过后人还在刚才那一屏。跳回登录页会把那一切一起卸载掉。

    贴顶而不是贴底：这一屏有输入框，手机软键盘弹出来会把贴底的对话框整个盖住。
    同一类组件在不同场合摆法不同，依据是「这一屏有没有键盘」，不是外观统一。

    Covers the current page instead of navigating. The page stays mounted behind
    it with its config draft intact, and a successful sign-in leaves you exactly
    where you were; redirecting to the login page would unmount all of it.

    Anchored to the top rather than the bottom: this one has an input, and a
    phone's software keyboard would cover a bottom-anchored dialog entirely.
  -->
  <div v-if="session.expired.value" class="session-expired" role="presentation">
    <section
      class="session-expired__dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <h2 id="session-expired-title">登录状态已过期</h2>
      <p>
        请重新输入密码继续。<strong>你在本页的改动都还在</strong>——验证通过后回到刚才的位置，配置草稿原样保留。
      </p>
      <form @submit.prevent="submit">
        <label>
          <span>{{ session.expiredFor.value?.username ?? '当前账户' }} 的密码</span>
          <!-- 显式 aria-label：包裹式 label 的可访问名会把标签和输入框之间的
               空白一起算进去，读屏念出来多一截，测试里也匹配不上。
               An explicit aria-label: a wrapping label's accessible name picks
               up the whitespace between the text and the field, which a screen
               reader announces and a test cannot match cleanly. -->
          <input
            ref="passwordInput"
            v-model="password"
            type="password"
            name="password"
            aria-label="密码"
            autocomplete="current-password"
            maxlength="256"
            required
            :disabled="submitting"
          >
        </label>
        <p v-if="error" class="session-expired__error" role="alert">{{ error }}</p>
        <button class="button button--primary" type="submit" :disabled="submitting || !password">
          {{ submitting ? '正在验证' : '继续' }}
        </button>
      </form>
      <button class="button button--secondary session-expired__leave" type="button" @click="leave">退出登录</button>
    </section>
  </div>
</template>

<style scoped>
.session-expired { position: fixed; inset: 0; z-index: 120; display: grid; align-content: start; justify-items: center; padding: 64px 16px 16px; overflow-y: auto; background: rgba(15, 20, 19, .58); }
.session-expired__dialog { width: min(420px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 22px 24px; border-radius: var(--r-2); background: var(--surface); box-shadow: 0 34px 76px -32px rgba(0, 0, 0, .6); }
.session-expired__dialog h2 { margin: 0; font-size: var(--t-4); font-weight: 600; }
.session-expired__dialog p { margin: 0; color: var(--muted); font-size: var(--t-2); line-height: 1.6; }
.session-expired__dialog p strong { color: var(--ink); font-weight: 600; }
.session-expired__dialog form { display: flex; flex-direction: column; gap: 10px; }
.session-expired__dialog label { display: grid; gap: 6px; color: var(--muted); font-size: var(--t-1); }
.session-expired__dialog input { width: 100%; height: 40px; padding: 0 11px; color: var(--ink); background: var(--canvas); border: 1px solid var(--line); border-radius: var(--r-1); outline: 0; font-size: var(--t-3); }
.session-expired__dialog input:focus { border-color: var(--ink); }
.session-expired__dialog .button { justify-content: center; min-height: 40px; }
.session-expired__error { color: var(--red); font-size: var(--t-1); overflow-wrap: anywhere; }
.session-expired__leave { justify-content: center; }

@media (max-width: 700px) {
  .session-expired { padding: 20px 12px 12px; }
  .session-expired__dialog { padding: 18px; gap: 12px; }
}
</style>
