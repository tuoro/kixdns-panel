import { watch } from 'vue'
import { useSession } from '../composables/useSession'
import { useToast } from '../composables/useToast'
import { appliedModel, changesBesidesFile, dialogEdits, draftGeneration, editorEdited, jsonEdited, model, sameDraftSince } from './store'
import { rebuildBlocklists, sayDrafted } from './useBlocklists'
import { conflict, draftBusy, keepDraftWhileAway, lastSaveWrite, pageAway, pendingWhen, save, stage, whenDraftSettles, type SaveWords } from './useConfigDocument'

// 立即更新下好以后怎么收场，放在一处：落地时、离开时放弃了修改以后、保存途中丢掉了之后改的以后，都走这里。
// 规矩只有一条：草稿里除了这份新文件没有别的修改，就直接存成「手动更新拦截列表」；有别的修改就留在草稿里，跟着下次保存。
// How a finished 立即更新 ends, in one place: on landing, after edits were dropped on leaving, after edits made during a save were dropped, it all comes
// here. One rule: with nothing in the draft besides this new file, it is saved at once as 「手动更新拦截列表」; with other edits it stays in the draft and goes
// with the next save.

// 下好、还没存上的那一次：记下当时草稿是哪一代。存上了（已保存的文件换了）就不用再管
// The download that landed and is not saved yet: the draft generation it landed in. Once saved (the saved file changed) there is nothing left to carry
let landed: { generation: number } | null = null
watch(() => appliedModel.value.blocklists.file, () => { landed = null })
/** 立即更新的新文件已经进了草稿、还没存上 / The new file from 立即更新 is in the draft and not saved yet */
export function noteLanded(): void { landed = { generation: draftGeneration() } }

const NB = '\u00a0'
const WORDS: SaveWords = {
  done: (version) => `已换上新下载的拦截列表（版本${NB}#${version}）`,
  pending: (version) => `新下载的拦截列表已存成待应用版本${NB}#${version}，${pendingWhen()}自动应用`,
  failed: '新下载的拦截列表没能存上：',
  kept: '它留在配置页的草稿里',
}

let carrying: Promise<void> | null = null
/**
 * 落地的那一次还没存上时，看草稿干不干净，干净就存。`fromLanding` 是落地时那一次：草稿在下载途中被换掉（放弃修改、恢复版本、重新读取）要说一句；
 * 离开时调用的那次不说，那时草稿早先在页上被换掉是人自己做的
 * With the landed download unsaved, checks whether the draft is clean and saves if so. `fromLanding` marks the call on landing: a draft replaced during the
 * download (a discard, a restore, a re-read) is worth a sentence; the call on leaving says nothing, since an earlier replacement on the page was the user's
 * own doing
 */
export function carryUpdate(button = '立即更新', fromLanding = false): Promise<void> {
  carrying ??= run(button, fromLanding).finally(() => { carrying = null })
  return carrying
}

async function run(button: string, fromLanding: boolean): Promise<void> {
  const toast = useToast()
  const session = useSession()
  // 保存、「现在应用」、恢复、删除版本、重新读取正在做：等它做完再看 / A save, 现在应用, a restore, a version delete or a re-read is under way: look once done
  for (let round = 0; round < 3; round++) {
    if (draftBusy.value) await whenDraftSettles()
    if (!landed || !session.authenticated.value) return
    if (!sameDraftSince(landed.generation)) {
      landed = null
      if (fromLanding) toast.info(`下载途中草稿换掉了，这次下载的没有放进草稿；要用新的一份，再点一次「${button}」`)
      return
    }
    // 草稿里没有这份新文件了（离开时放弃了修改，或者丢掉了保存开始后改的）：服务端还存着刚下好的那份，按现在的订阅再合成一次
    // The draft no longer holds the new file (edits dropped on leaving, or those made after a save began): the server still holds the fresh download,
    // so it builds once more for the subscriptions now in the draft
    if (model.blocklists.file === appliedModel.value.blocklists.file) {
      const rebuilt = await rebuildBlocklists([], false, true)
      if (rebuilt.outcome !== 'filled' || model.blocklists.file === appliedModel.value.blocklists.file) { landed = null; return }
    }
    if (!draftBusy.value) break
  }
  if (draftBusy.value) return
  // 有没有别的修改和保存条一个口径：面板填进去的合成文件不算 / Other edits by the save bar's yardstick: the merged file the panel fills in does not count
  const clean = changesBesidesFile(appliedModel.value, model) === 0 && !editorEdited.value && !jsonEdited.value && dialogEdits.size === 0
  // 冲突状态下保存注定撞上：照实说要先重新读取 / In a conflict a save is bound to collide: it says plainly to re-read first
  if (conflict.value) {
    if (pageAway()) toast.info(`新下载的拦截列表没能存上：配置在别处改过了；回到配置页重新读取以后，再点一次「${button}」`)
    else sayDrafted('新的一份已放进草稿；这份配置在别处改过了，先重新读取，再点一次「立即更新」')
    return
  }
  if (!clean) {
    // 人不在配置页：回来时留着这份草稿，不让回来那次读把新的一份冲掉 / Off the config page: the draft is kept for the return, so its read does not wash the
    // new copy away
    if (!pageAway()) sayDrafted('新的一份已放进草稿，保存后生效')
    else { keepDraftWhileAway(); toast.info('新下载的拦截列表已放进草稿，回到配置页保存后生效') }
    return
  }
  await save('draft', '手动更新拦截列表', WORDS)
  // 人在配置页上时由这里说（保存条只说版本）；不在页上时保存自己会说，用上面给的说法。存成了待应用：照保存条说，不说「已换上」
  // On the config page it is said here (the save bar only gives the version); off it the save itself says it in the words above. Stored as pending: said
  // as the save bar says it, not 已换上
  const written = lastSaveWrite()
  if (pageAway() || stage.value !== 'done' || !written) return
  if (written.state === 'pending') toast.info(WORDS.pending!(written.version))
  else toast.success(WORDS.done!(written.version))
}
