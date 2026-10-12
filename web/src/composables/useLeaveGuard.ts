// 有没保存内容的页面在这里登记「离开前问一句」。退出登录这类不只是换页的离开，先问这一句，再结束会话；
// 问过并且同意了，紧接着的那次换页就不再问第二遍。
// A page with unsaved work registers its "ask before leaving" here. Leaving that is more than a page change, such as signing out,
// asks it first and only then ends the session; once agreed, the page change that follows does not ask a second time.
type Ask = () => Promise<boolean>

let current: Ask | null = null
let pending: (() => boolean) | null = null
let agreed = false

/** hasPending 说现在有没有没保存的修改，不问人 / hasPending tells whether anything is unsaved right now, without asking */
export function registerLeaveGuard(ask: Ask, hasPending: () => boolean): () => void {
  current = ask
  pending = hasPending
  return () => { if (current === ask) { current = null; pending = null } }
}

/**
 * 不问就走（会话过期时用）：放行紧接着的那次换页，返回丢下的有没有没保存的修改。没有页面登记时什么都不记，免得「同意过」留到以后
 * Leave without asking (on session expiry): lets the page change right after it pass, and returns whether unsaved work was left behind.
 * With no page registered nothing is recorded, so no agreement lingers
 */
export function leaveWithoutAsking(): boolean {
  // 不在页面上、只在内存里的草稿也算：会话过期时它一样留不下来，就此放下；配置页开着、保存还在路上也放下，那次保存的结果不再报
  // A draft held only in memory, away from its page, counts too: it cannot survive the expiry either, so it is let go; so is a save still on its way
  // with the config page open, and its result is no longer reported
  const heldLost = held?.has() ?? false
  const savingLost = held?.saving() ?? false
  if (heldLost || savingLost) held?.drop()
  if (!current) return heldLost
  agreed = true
  return (pending?.() ?? false) || heldLost || savingLost
}

// 页面已经离开、草稿还在内存里（离开配置页时还在保存，或者没保存成功留着）：登记一下，会话过期时知道有它
// A page already left with its draft still in memory (a save in flight when leaving the config page, or a failed one kept): registered so session expiry knows about it
let held: { has: () => boolean; saving: () => boolean; drop: () => void; ask: Ask } | null = null
/** saving：配置页的保存还在路上（不管页面开没开着） / saving: the config page's save is still on its way (whether or not the page is open) */
export function registerHeldDraft(has: () => boolean, saving: () => boolean, drop: () => void, ask: Ask): void {
  held = { has, saving, drop, ask }
}

/** 先问登记过的页面；没有登记就直接放行。 / Ask the registered page first; pass straight through when none is registered. */
export async function confirmLeave(): Promise<boolean> {
  // 没有页面登记就直接放行，也不记「同意过」：否则这一下会留到以后，让配置页某次离开不再问
  // With no page registered it passes without recording agreement: otherwise the flag lingers and some later leave of the config page goes unasked
  if (!current) {
    // 配置页不在，但它的草稿还在内存里（正在保存或没保存成功）：退出登录前也问一句，同意就放下 / The config page is gone but its draft is held in memory: ask before signing out too, and let it go on agreement
    if (!held?.has()) return true
    const agreedHeld = await held.ask()
    if (agreedHeld) held.drop()
    return agreedHeld
  }
  // 配置页开着、保存还在路上：和在别处一样问「配置页的保存还没做完」，同意就放下（那次保存的结果不再报，没存上的也不留）
  // The config page is open with a save on its way: ask 配置页的保存还没做完 as from anywhere else, and let it go on agreement (its result is no longer
  // reported, nor is a failed draft kept)
  if (held?.saving()) {
    agreed = await held.ask()
    if (agreed) held.drop()
    return agreed
  }
  agreed = await current()
  return agreed
}

/** 路由守卫里用：刚问过并同意了就放行一次。 / For route guards: pass once right after an agreed ask. */
export function takeAgreement(): boolean {
  const was = agreed
  agreed = false
  return was
}
