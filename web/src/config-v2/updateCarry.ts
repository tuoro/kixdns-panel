import { watch } from 'vue'
import { useConnection } from '../composables/useConnection'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { appliedModel, changesBesidesFile, dialogEdits, draftGeneration, editorEdited, jsonEdited, model, sameDraftSince } from './store'
import { dismissDraftedFailure, rebuildBlocklists, sayDrafted } from './useBlocklists'
import { conflict, conflictToldAway, draftBusy, keepDraftWhileAway, lastSaveLost, lastSaveWrite, pageAway, pendingWhen, save, stage, whenDraftSettles, type SaveWords } from './useConfigDocument'

// 立即更新下好以后怎么收场，放在一处：落地时、离开时放弃了修改以后、保存途中丢掉了之后改的以后，都走这里。
// 规矩只有一条：草稿里除了这份新文件没有别的修改，就直接存成「手动更新拦截列表」；有别的修改就留在草稿里，跟着下次保存。
// How a finished 立即更新 ends, in one place: on landing, after edits were dropped on leaving, after edits made during a save were dropped, it all comes
// here. One rule: with nothing in the draft besides this new file, it is saved at once as 「手动更新拦截列表」; with other edits it stays in the draft and goes
// with the next save.

// 下好、还没存上的那一次：落地时草稿是哪一代、落地的是哪个文件（订阅在途中变了时还不知道，为 null）、按的是哪个按钮。
// 存上了带着它的文件才算完（见下面的 watch）；已保存的文件因为别的原因换了（恢复、删除待应用版本、草稿换过以后的保存）不算
// The download that landed and is not saved yet: the draft generation it landed in, the file it landed (null when the subscriptions changed meanwhile and
// it is not known yet), the button pressed. It is done only once a file carrying it is saved (see the watch below); the saved file changing for another
// reason (a restore, deleting a pending version, a save after the draft was replaced) does not count
let landed: { generation: number; file: string | null; button: string } | null = null
// 存上了就清掉：已保存的文件换成了落地的那份；或者换成了草稿里的那份，而文件还不知道、或者落地以后草稿没有整份换过——那时草稿里的文件不是落地的那份，
// 就是之后按改过的订阅再合成的（服务端留着新下载的那份，合成都用它），存上了它也就存上了这次下载
// Cleared once saved: the saved file became the landed one; or it became the draft's, with the file not known yet or the draft not replaced wholesale
// since landing — the draft's file is then either the landed one or built afterwards for changed subscriptions (the server keeps the fresh download and
// every build uses it), so saving it saved this download too
watch(() => appliedModel.value.blocklists.file, (file) => {
  if (!landed || !file) return
  if (file === landed.file || (file === model.blocklists.file && (landed.file === null || draftGeneration() === landed.generation))) landed = null
})
/** 立即更新的新文件已经进了草稿、还没存上；`known` 为假时文件还没填进来（订阅在途中变了） / The new file from 立即更新 is in the draft and not saved yet;
 * with `known` false the file is not filled in yet (the subscriptions changed meanwhile) */
export function noteLanded(button: string, known = true): void {
  landed = { generation: draftGeneration(), file: known ? model.blocklists.file : null, button }
}
/** 离开之前：草稿里还是落地的那份文件（中间在页上放弃又撤销过也算），就从现在这一代接着认 / Before leaving: when the draft still holds the landed file (a
 * discard on the page undone since counts too), it is recognised from the current generation on */
export function refreshLanded(): void {
  if (landed?.file && model.blocklists.file === landed.file) landed.generation = draftGeneration()
}
// 草稿换过以后还算不算这一次的：只隔着离开时的放弃，或者草稿里还是这份文件 / Whether the draft still belongs to this landing after replacements: only
// discards on leaving lie between, or the draft still holds this file
const stillOurs = () => landed !== null && (sameDraftSince(landed.generation) || (landed.file !== null && model.blocklists.file === landed.file))

const NB = '\u00a0'
const words = (button: string): SaveWords => ({
  done: (version) => `已换上新下载的拦截列表（版本${NB}#${version}）`,
  // 「：」给提示条一个能折行的地方，版本号不会被拆开 / The 「：」 gives the toast a place to wrap, so the version number is never split
  pending: (version) => `新下载的拦截列表：已存成待应用版本${NB}#${version}，${pendingWhen()}自动应用`,
  subject: '新下载的拦截列表',
  conflict: `新下载的拦截列表没能存上：这份配置在别处改过了；回到配置页重新读取，再点一次「${button}」`,
  kept: '它留在配置页的草稿里',
  again: `再点一次「${button}」`,
})
// 在配置页上撞上「别处改过了」：重新读取会换掉草稿，新的一份跟着没了，所以说要再点一次（不说「已放进草稿」） / Meeting 别处改过了 on the config page:
// re-reading replaces the draft and the new copy with it, so it says to press again (not that the copy is in the draft)
const conflictHere = (button: string) => `新的一份存不上：这份配置在别处改过了；先重新读取，再点一次「${button}」`
// 没存上的那条红色提示：保存栏的失败、冲突过去了（再改、再存、放弃、重新读取）就收起 / The red not-saved toast goes once the save bar's failure or conflict
// is over (another edit or save, a discard, a re-read)
watch(() => stage.value === 'failed' || conflict.value, (stuck) => { if (!stuck) dismissDraftedFailure() })

// 一次一次地收场：正在收场时又落地一次，排在后面再看一遍，不并进前一次 / One ending at a time: a landing while another ends is queued and looked at
// afterwards, not merged into it
let carrying: Promise<void> = Promise.resolve()
/**
 * 落地的那一次还没存上时，看草稿干不干净，干净就存。`fromLanding` 是落地时那一次：草稿在下载途中被换掉（放弃修改、恢复版本）要说一句；
 * 离开时调用的那次不说，那时草稿早先在页上被换掉是人自己做的
 * With the landed download unsaved, checks whether the draft is clean and saves if so. `fromLanding` marks the call on landing: a draft replaced during the
 * download (a discard, a restore) is worth a sentence; the call on leaving says nothing, since an earlier replacement on the page was the user's own doing
 */
export function carryUpdate(fromLanding = false): Promise<void> {
  // 一次出错不能卡住后面的：排队的链接住错误 / One failure must not stall the rest: the queue swallows its errors
  carrying = carrying.then(() => run(fromLanding)).catch(() => undefined)
  return carrying
}

// 离开以后补的那次合成因为连不上没成：连上后再来一次 / The build made up after leaving failed for want of the panel: once it is back, once more
let retryWhenBack = false
watch(useConnection().down, (isDown) => {
  if (isDown || !retryWhenBack) return
  retryWhenBack = false
  void carryUpdate()
})
// 会话结束（退出登录、过期）：没存上的那次一起放下，和退出时说的「草稿会被丢弃」一样，不留到下一个会话里突然存出一个版本（用户定的）
// The session ends (sign-out, expiry): the unsaved landing goes too, as the sign-out said the draft would be dropped, so no version suddenly appears in
// the next session (the user's call)
watch(() => useSession().authenticated.value, (now) => {
  if (now) return
  landed = null
  retryWhenBack = false
})

async function run(fromLanding: boolean): Promise<void> {
  const toast = useToast()
  const session = useSession()
  // 保存、「现在应用」、恢复、删除版本、重新读取正在做：等它做完再看 / A save, 现在应用, a restore, a version delete or a re-read is under way: look once done
  for (let round = 0; round < 3; round++) {
    if (draftBusy.value) await whenDraftSettles()
    if (!landed || !session.authenticated.value) return
    // 正是这份文件存上了（跟着别的保存一起，或者前一次收场存的） / This very file got saved (along with another save, or by the previous ending)
    if (landed.file !== null && appliedModel.value.blocklists.file === landed.file) { landed = null; return }
    if (!stillOurs()) {
      const button = landed.button
      landed = null
      if (fromLanding) toast.info(`下载途中草稿换掉了，这次下载的没有放进草稿；要用新的一份，再点一次「${button}」`)
      return
    }
    // 草稿里没有这份新文件了（离开时放弃了修改，或者丢掉了保存开始后改的）：服务端还存着刚下好的那份，按现在的订阅再合成一次
    // The draft no longer holds the new file (edits dropped on leaving, or those made after a save began): the server still holds the fresh download,
    // so it builds once more for the subscriptions now in the draft
    if (model.blocklists.file === appliedModel.value.blocklists.file) {
      const rebuilt = await rebuildBlocklists([], false, true)
      if (rebuilt.outcome === 'failed' && rebuilt.down) { retryWhenBack = true; return }
      if (rebuilt.outcome !== 'filled' || model.blocklists.file === appliedModel.value.blocklists.file) { landed = null; return }
      landed = { generation: draftGeneration(), file: model.blocklists.file, button: landed.button }
    }
    if (!draftBusy.value) break
  }
  if (!landed || draftBusy.value) return
  const button = landed.button
  // 有没有别的修改和保存条一个口径：面板填进去的合成文件不算 / Other edits by the save bar's yardstick: the merged file the panel fills in does not count
  const clean = changesBesidesFile(appliedModel.value, model) === 0 && !editorEdited.value && !jsonEdited.value && dialogEdits.size === 0
  // 冲突状态下保存注定撞上：照实说要先重新读取。离开以后人自己那次保存撞上时已经有一条说了冲突：这条只说新下载的也没存上
  // In a conflict a save is bound to collide: it says plainly to re-read first. Away, when the user's own save already met it and a toast said so,
  // this one only says the new download was not saved either
  if (conflict.value) {
    if (!pageAway()) sayDrafted(conflictHere(button), true)
    else sayDrafted(conflictToldAway() ? `新下载的拦截列表也没存上：回到配置页重新读取，${words(button).again}` : words(button).conflict!, true)
    return
  }
  if (!clean) {
    // 人不在配置页：回来时留着这份草稿，不让回来那次读把新的一份冲掉 / Off the config page: the draft is kept for the return, so its read does not wash the
    // new copy away
    if (!pageAway()) sayDrafted('新的一份已放进草稿，保存后生效')
    else { keepDraftWhileAway(); toast.info('新下载的拦截列表已放进草稿，回到配置页保存后生效') }
    return
  }
  await save('draft', '手动更新拦截列表', words(button))
  // 人在配置页上时由这里说（保存条只说版本）；不在页上时保存自己会说，用上面给的说法。存成了待应用：照保存条说，不说「已换上」
  // On the config page it is said here (the save bar only gives the version); off it the save itself says it in the words above. Stored as pending: said
  // as the save bar says it, not 已换上
  if (pageAway()) return
  const written = lastSaveWrite()
  // 没存上：原因在保存栏，这里点一句，挂到失败过去为止；撞上冲突时说要再点一次。写入时回应丢了不算没存上：保存那边说了「不知道存上没有」，核对完换成结果
  // Not saved: the save bar has the reason, this points to it and stays until the failure is over; on a conflict it says to press again. An answer lost
  // while writing is not a failure: the save said 不知道存上没有 and the check replaces it with the result
  if (stage.value === 'failed') {
    if (!lastSaveLost()) sayDrafted(conflict.value ? conflictHere(button) : '新下载的拦截列表没能存上，原因写在保存栏', true)
    return
  }
  if (stage.value !== 'done' || !written) return
  if (written.state === 'pending') toast.info(words(button).pending!(written.version))
  else toast.success(words(button).done!(written.version))
}
