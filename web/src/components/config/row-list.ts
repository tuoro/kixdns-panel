import { ArrowDown, ArrowUp } from '@lucide/vue'
import { nextTick, type Ref } from 'vue'
import type { UiMenuItem } from '../ui/UiMenu.vue'

// 子项行（条件、动作、映射）共用的两件事：「调整顺序」菜单的项，和焦点跟着行走（规范 2.11）。
// Shared by sub-item rows (conditions, actions, mappings): the reorder menu's items, and focus that
// follows the row (spec 2.11).

export type RowMove = 'up' | 'down'

// 到头的那一项是灰的：菜单里看得出为什么按不了 / The item that would go past the end is disabled
export function moveItems(index: number, length: number): UiMenuItem[] {
  return [
    { value: 'up', label: '上移', icon: ArrowUp, disabled: index === 0 },
    { value: 'down', label: '下移', icon: ArrowDown, disabled: index === length - 1 },
  ]
}

export function moveTarget(index: number, length: number, direction: string): number | undefined {
  const target = index + (direction === 'up' ? -1 : 1)
  return target >= 0 && target < length ? target : undefined
}

// 加一行，焦点落在新行的类型；删一行，落到原来位置上的那一行（删的是最后一行就落到新的最后一行，
// 一行都不剩就落在「添加」按钮上）；挪一行，落在它挪过去之后的序号按钮上，可以接着挪。
// Adding focuses the new row's type; removing focuses whatever row now holds that position (the new
// last row if the last was removed, the add button if none are left); moving focuses the moved row's
// ordinal so it can be moved again.
export function useRowFocus(root: Ref<HTMLElement | null>) {
  async function focusRow(index: number, target: 'type' | 'handle'): Promise<void> {
    await nextTick()
    const rows = root.value?.querySelectorAll<HTMLElement>(':scope > .ui-rows > .ui-rows__row') ?? []
    const row = rows.length ? rows[Math.min(index, rows.length - 1)] : undefined
    const element = row?.querySelector<HTMLElement>(target === 'handle' ? '.ui-rows__handle' : '.ui-rows__type select')
      ?? root.value?.querySelector<HTMLElement>(':scope > .ui-rows__add')
    element?.focus()
  }
  return { focusRow }
}
