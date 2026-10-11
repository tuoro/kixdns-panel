// 有没保存内容的页面在这里登记「离开前问一句」。退出登录这类不只是换页的离开，先问这一句，再结束会话；
// 问过并且同意了，紧接着的那次换页就不再问第二遍。
// A page with unsaved work registers its "ask before leaving" here. Leaving that is more than a page change, such as signing out,
// asks it first and only then ends the session; once agreed, the page change that follows does not ask a second time.
type Ask = () => Promise<boolean>

let current: Ask | null = null
let agreed = false

export function registerLeaveGuard(ask: Ask): () => void {
  current = ask
  return () => { if (current === ask) current = null }
}

/** 先问登记过的页面；没有登记就直接放行。 / Ask the registered page first; pass straight through when none is registered. */
export async function confirmLeave(): Promise<boolean> {
  agreed = current ? await current() : true
  return agreed
}

/** 路由守卫里用：刚问过并同意了就放行一次。 / For route guards: pass once right after an agreed ask. */
export function takeAgreement(): boolean {
  const was = agreed
  agreed = false
  return was
}
