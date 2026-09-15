import { expect, type Page } from '@playwright/test'

/**
 * 点掉设计体系里的确认框。
 *
 * 原生 window.confirm 已经全部换掉，所以 dialog 事件不再触发；而且顺序反过来了：
 * 原生对话框在点击那一刻同步处理，新的框是点击之后才出现，要等它渲染出来再点。
 *
 * The design-system confirm dialog. Native window.confirm is gone so the dialog
 * event no longer fires, and the order inverts: the native one was handled at
 * the moment of the click, while this one appears after it and has to be waited
 * for before being answered.
 */
export async function acceptConfirm(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  // 主按钮是最后一个——取消在左，确认在右。
  await dialog.getByRole('button').last().click()
  await expect(dialog).toHaveCount(0)
}

export async function cancelConfirm(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button').first().click()
  await expect(dialog).toHaveCount(0)
}
