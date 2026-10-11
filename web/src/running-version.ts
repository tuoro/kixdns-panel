import type { ConfigVersion } from './api/types'

// 正在运行的是面板保存的哪一个版本：按内容摘要对上历史版本，同一份内容保存过几次时取最新的那个。
// 对不上（配置是在面板之外改的，或者历史里已经删掉）就返回 null，页面不编一个号出来。
// 内核自己的「配置代次」从 1 数起、重启就清零，和配置页、历史版本里的号对不上，所以页头不用它。
// Which saved panel version is running: matched against the history by content digest, the newest one when the same content was
// saved more than once. No match (the config was edited outside the panel, or that version was deleted) returns null, and the page
// invents no number. The kernel's own config generation counts from 1 and resets on restart, so it never matches the numbers on the
// config page or in the history, and headers do not use it.
export function runningVersionId(activeSha: string | null | undefined, versions: readonly ConfigVersion[]): number | null {
  if (!activeSha) return null
  const match = [...versions].sort((a, b) => b.id - a.id).find((version) => version.sha256 === activeSha)
  return match?.id ?? null
}
