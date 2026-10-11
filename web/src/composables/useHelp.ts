import { readonly, ref } from 'vue'
import type { HelpPage } from '../help/topics'

// 帮助抽屉是全站一个：概念词条按当前页列，快捷键一览固定在底部。哪里都能打开它（页头「…」里的「帮助」、账户菜单、? 键、「?」弹层里的「全部说明」）。
// One help drawer for the whole site: topics for the current page, the shortcut list at the bottom. Opened from anywhere (帮助 in the header's 「…」, the account menu, the ? key, 全部说明 in a 「?」 popover).
export interface HelpRequest { page: HelpPage; section: 'topics' | 'shortcuts'; topic?: string }

const request = ref<HelpRequest | null>(null)

export function useHelp() {
  function show(page: HelpPage, section: 'topics' | 'shortcuts' = 'topics', topic?: string): void { request.value = { page, section, topic } }
  function hide(): void { request.value = null }
  return { request: readonly(request), show, hide }
}
