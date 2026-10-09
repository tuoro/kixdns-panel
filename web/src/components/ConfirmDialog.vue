<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useConfirm } from '../composables/useConfirm'
import UiDotText from './ui/UiDotText.vue'

const confirm = useConfirm()
const confirmButton = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
let returnFocus: HTMLElement | null = null
/**
 * 刚打开的那一瞬间要忽略一次 cancel。
 *
 * 触发确认框的动作本身可能就是按 Esc（比如在检查器里按 Esc 关闭）。浏览器处理完
 * 应用的 keydown 之后，会继续把这次 Esc 交给此刻已经进入顶层的 <dialog>，于是框
 * 刚出现就被自己关掉——用户看到的是一闪而过。
 *
 * A cancel arriving the instant it opens has to be ignored. The action that
 * raises the confirmation may itself be an Esc press — closing the inspector,
 * say — and once the application's keydown has been handled the browser goes on
 * to deliver that same Esc to the <dialog> now sitting in the top layer, so the
 * confirmation closes itself the moment it appears and the user sees a flash.
 */
let justOpened = false

/**
 * 关掉之后把焦点还给打开它之前的那个元素。
 *
 * 不还的话焦点会掉到 body 上，键盘用户当场失去位置，随后的 Esc、Tab 也都打在空处
 * ——原来的 window.confirm 是浏览器自己处理这件事的，换成自绘的框就得自己做。
 *
 * Returns focus to whatever held it before opening. Without this it falls to the
 * body, a keyboard user loses their place, and any following Esc or Tab lands
 * nowhere — the browser handled this for window.confirm, and taking over the
 * dialog means taking over this too.
 */
watch(() => confirm.pending.value, (request) => {
  const element = dialog.value
  if (!element) return
  if (!request) {
    if (element.open) element.close()
    returnFocus?.isConnected && returnFocus.focus({ preventScroll: true })
    returnFocus = null
    return
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // <dialog> 元素本身常驻，只有内容随 pending 出现和消失。
  // 用 v-if 连元素一起销毁是不行的：一个还处于 showModal 状态的元素被移出 DOM 之后，
  // 浏览器的顶层状态不会跟着复位，下一次 showModal 就打不开了。
  //
  // The <dialog> element itself persists and only its contents come and go with
  // pending. Destroying the element with v-if does not work: removing one that
  // is still in its showModal state leaves the browser's top-layer state behind,
  // and the next showModal simply does not open.
  //
  // showModal 而不是 open 属性：配置页的版本历史本身就是一个原生 <dialog>，
  // 只有同样进入顶层才压得住它，z-index 再高也没用。
  //
  // showModal rather than the open attribute: the config page's version history
  // is itself a native <dialog>, and only joining the top layer can rise above
  // it — no z-index can.
  if (!element.open) {
    justOpened = true
    element.showModal()
    setTimeout(() => { justOpened = false })
  }
  confirmButton.value?.focus()
}, { flush: 'post' })

const bodyText = computed(() => confirm.pending.value?.body ?? '')
</script>

<template>
  <!--
    居中，容器跟随动态视口：手机上软键盘弹出来时容器一起缩，框自己重新居中。
    flex + 子元素 margin:auto 是安全的居中写法——内容超高时从顶部开始滚，
    而不像 align-content:center 那样把上半截裁掉够不着。

    Centred, with the container tracking the dynamic viewport so a phone's
    keyboard shrinks it and the dialog re-centres. flex plus margin:auto on the
    child is the safe centring: overflowing content scrolls from the top instead
    of having its upper half clipped out of reach.
  -->
  <dialog
    ref="dialog"
    class="confirm"
    role="alertdialog"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-body"
    @cancel.prevent="justOpened || confirm.settle(false)"
    @click.self="confirm.settle(false)"
  >
    <section v-if="confirm.pending.value" class="confirm__dialog">
      <h2 id="confirm-title">{{ confirm.pending.value.title }}</h2>
      <p id="confirm-body">{{ bodyText }}</p>
      <ul v-if="confirm.pending.value.items?.length" class="confirm__items">
        <!-- 「#12 · 备注」这样的项按「·」分段：点不在行首，折行落在它后面时藏起来 / Items such as 「#12 · note」 split at their 「·」: never at a line start, hidden when a wrap falls right after it -->
        <li v-for="item in confirm.pending.value.items" :key="item"><UiDotText :parts="item.split('\u00a0· ')" /></li>
      </ul>
      <div class="confirm__actions">
        <button class="ui-btn ui-btn--secondary" type="button" @click="confirm.settle(false)">
          {{ confirm.pending.value.cancelLabel ?? '取消' }}
        </button>
        <!-- 主按钮写动词和数量，不写「确定」。红色只给不可撤销的操作。 -->
        <button
          ref="confirmButton"
          class="ui-btn"
          :class="confirm.pending.value.destructive ? 'ui-btn--critical' : 'ui-btn--primary'"
          type="button"
          @click="confirm.settle(true)"
        >
          {{ confirm.pending.value.confirmLabel }}
        </button>
      </div>
    </section>
  </dialog>
</template>

<style scoped>
/* 原生 <dialog> 默认带边框和 auto 宽高，全部去掉；遮罩交给 ::backdrop。 */
.confirm { max-width: 100vw; max-height: 100dvh; width: 100%; height: 100dvh; margin: 0; padding: 24px 16px; border: 0; background: transparent; overflow-y: auto; display: flex; }
.confirm:not([open]) { display: none; }
.confirm::backdrop { background: var(--scrim); }
.confirm__dialog { width: min(500px, 100%); margin: auto; display: flex; flex-direction: column; gap: var(--s-2); padding: var(--s-5); border-radius: var(--r-3); background: var(--surface); box-shadow: var(--shadow-float); }
.confirm__dialog h2 { margin: 0; font-size: var(--t-4); font-weight: 600; }
.confirm__dialog p { margin: 0; color: var(--l-ink-2); font-size: var(--t-3); line-height: var(--lh-base); white-space: pre-line; }
.confirm__items { display: grid; gap: 3px; margin: 0; padding: 10px 12px; list-style: none; background: var(--canvas); border-radius: var(--r-1); color: var(--ink); font-family: var(--mono); font-size: var(--t-1); }
.confirm__actions { display: flex; justify-content: flex-end; gap: var(--s-2); margin-top: var(--s-3); }

@media (max-width: 700px) {
  /* 手机上和其他弹层一样从底边升起：抓手、上面两角圆、按钮满宽 / On a phone it rises from the bottom like every other sheet: grabber, rounded top corners, full-width buttons */
  .confirm[open] { display: grid; place-items: end stretch; width: 100%; max-width: none; height: 100%; max-height: none; margin: 0; padding: 0; background: transparent; }
  .confirm__dialog { width: 100%; margin: 0; padding: var(--s-2) var(--s-4) calc(var(--s-4) + env(safe-area-inset-bottom)); border-radius: var(--r-3) var(--r-3) 0 0; animation: ui-sheet-in var(--m-base) var(--ease-out); }
  .confirm__dialog::before { width: var(--s-6); height: var(--s-1); margin: 0 auto var(--s-2); border-radius: var(--r-full); background: var(--l-line-strong); content: ''; }
  /* 窄屏按钮满宽竖排，主操作在上——拇指够得着的位置留给最常点的那个。 */
  .confirm__actions { flex-direction: column-reverse; }
  .confirm__actions .ui-btn { width: 100%; }
}
</style>
