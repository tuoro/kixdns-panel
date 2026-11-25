// 内核逐条说的配置问题（校验被拒时 422 的 problems、重载被拒时的 last_reload.problems、启动时读的配置的 problems）。每条开头是说哪一处
// 的路径（pipelines[0].rules[2].matchers[1]: …、settings.bind_udp: …），按位置说，因为规则名可以重复。这里把路径换成配置页上的叫法，
// 后面内核的原话照留；认不出的整条照原样
// The configuration problems the kernel lists one by one (a 422's problems on a refused validation, last_reload.problems on a refused
// reload, the problems of the config read at startup). Each opens with the path of the place it speaks of (pipelines[0].rules[2].matchers[1]:
// …, settings.bind_udp: …), by place because rule names may repeat. Here the path becomes what the config page calls it, and the kernel's
// words after it stay as they are; anything not recognised stays whole

/**
 * 内核不认面板的配置块（顶层 panel 键）时说的话。2026.11.23.11 到 2026.11.25.27 的内核把它当作不读的键：启动时记成问题，校验和重载都
 * 拒绝，所以保存、恢复版本、Geo 数据和拦截列表的更新全都没法生效；之后的内核接受它，并声明 config_panel_block_v1。panel 里是面板的整份
 * 模型，剥掉它会丢掉规则名、备注、停用的规则，所以只能更新内核
 * What is said when the kernel does not take the panel's block (the top-level panel key). Kernels 2026.11.23.11 to 2026.11.25.27 treat it as
 * a key they do not read: a problem at startup, refused by validation and reloads, so saves, restored versions and Geo data or blocklist
 * updates all fail to take; later kernels take it and declare config_panel_block_v1. panel holds the panel's whole model, and stripping it
 * would lose rule names, notes and disabled rules, so updating the kernel is the only way
 */
export const PANEL_BLOCK_HINT = '当前内核版本不认面板的配置块，请到系统页把内核更新到最新版'

// 按内核说的原因认，不按版本号猜：一条问题就是它（problems 里），或者在原因连成的一句里（更早的内核只给这一句，几条之间用「; 」连着，
// 前面可能还有面板的说法和冒号）。只认顶层的 panel：pipelines[0].panel 这样的路径前面是「.」，不算
// Told by the kernel's reason, never guessed from a version: one problem is this (in problems), or it sits inside the reasons joined into
// one sentence (all an earlier kernel gives, the problems joined by 「; 」, perhaps after the panel's own words and a colon). Only the
// top-level panel counts: a path such as pipelines[0].panel has a 「.」 before it and is not this
const PANEL_BLOCK = /(?:^|[;；:：]\s*)panel: the kernel does not read this key/

/** 这句话（内核的原话，或者面板带着它说的话）说的是不认面板的配置块 / Whether this text (the kernel's words, or the panel's words carrying them) says the panel's block is not taken */
export const refusesPanelBlock = (text: string): boolean => PANEL_BLOCK.test(text)

/** 说不认面板配置块的话换成 PANEL_BLOCK_HINT，别的照原样（Geo 数据、拦截列表的更新没成时的原因这类） / Words saying the panel's block is not taken become PANEL_BLOCK_HINT, anything else stays (why a Geo data or blocklist update failed, say) */
export const panelBlockWords = (text: string): string => (refusesPanelBlock(text) ? PANEL_BLOCK_HINT : text)

/** 说的是不是 PANEL_BLOCK_HINT：页面在它旁边放去更新内核的链接（KERNEL_UPDATE） / Whether the text says PANEL_BLOCK_HINT: the page puts a link to the kernel's update (KERNEL_UPDATE) beside it */
export const saysPanelBlock = (text: string): boolean => text.includes(PANEL_BLOCK_HINT)

/** 系统页上更新内核的那一行：跳过去时它滚到眼前，「更新」按钮拿到焦点 / The kernel's update row on the system page: going there scrolls it into view and gives its 更新 button the focus */
export const KERNEL_UPDATE = { path: '/system', hash: '#kernel-update' } as const
export const KERNEL_UPDATE_LABEL = '去更新内核'

/**
 * 路径里的各处在页面上怎么叫；认不出时给 null，那一条照原样说
 * What the places in a path are called on the page; null when unknown, and that problem is said as it came
 */
export interface PlaceNames {
  /** pipelines[i]：「主列表」「规则组「内网」」这样 / pipelines[i]: 主列表, 规则组「内网」 and the like */
  pipeline: (i: number) => string | null
  /** pipelines[i].rules[j]：「规则「广告」」这样 / pipelines[i].rules[j]: 规则「广告」 and the like */
  rule: (i: number, j: number) => string | null
  /** 引号里的 Pipeline id（跳转、选择写的那个）怎么叫 / What a quoted pipeline id (one a jump or a selector names) is called */
  quoted?: (id: string) => string | null
}

// 开头的路径：哪个 Pipeline、哪条规则、哪个设置，后面还有一截（.matchers[1]、.ecs.prefix）时另外记着；再往后是内核的原话
// The opening path: which pipeline, which rule or which setting, with any further part (.matchers[1], .ecs.prefix) kept apart; after it come the kernel's words
const PLACE = /^(?:pipelines\[(\d+)\](?:\.rules\[(\d+)\])?|settings\.(\w+))((?:\.\w+|\[\d+\])*): ([\s\S]+)$/

/**
 * 内核说的一条问题，换成页面上的说法：不认面板配置块的那条说怎么办；开头的路径换成规则、列表、设置在页面上的叫法（路径后面多的一截放在
 * 括号里，高级规则看得懂），引号里的 Pipeline id 后面补上它的叫法。settingName 给设置的叫法
 * One problem the kernel names, in the page's words: the one about the panel's block says what to do; the opening path becomes what the
 * rule, list or setting is called on the page (any further part of the path in brackets, which an advanced rule can follow), and a quoted
 * pipeline id gets its name after it. settingName names a setting
 */
export function describeProblem(problem: string, names: PlaceNames | null, settingName: (key: string) => string): string {
  if (refusesPanelBlock(problem)) return PANEL_BLOCK_HINT
  const place = PLACE.exec(problem)
  if (!place) return problem
  const [, pipeline, rule, setting, further, said] = place
  const where = setting !== undefined ? `设置 ${settingName(setting)}`
    : !names ? null
      : rule !== undefined ? names.rule(Number(pipeline), Number(rule)) : names.pipeline(Number(pipeline))
  if (!where) return problem
  const words = names?.quoted ? said!.replace(/"([\w.-]+)"/g, (whole, id: string) => { const name = names.quoted!(id); return name ? `${whole}（${name}）` : whole }) : said!
  return `${where}${further ? `（${further.replace(/^\./, '')}）` : ''}：${words}`
}

/**
 * 几条问题换成页面上的说法（见 describeProblem）；不认面板配置块的那条不列，由 blocked 说：那时先要更新内核
 * Several problems in the page's words (see describeProblem); the one about the panel's block is not listed but told by blocked: the kernel
 * then has to be updated first
 */
export function describeProblems(problems: readonly string[], names: PlaceNames | null, settingName: (key: string) => string): { blocked: boolean; items: string[] } {
  const items = problems.filter((problem) => !refusesPanelBlock(problem)).map((problem) => describeProblem(problem, names, settingName))
  return { blocked: items.length < problems.length, items }
}

/**
 * 一块内核报来的事：一句标题、一句说明、逐条的内容；update 时旁边给去更新内核的按钮
 * One thing the kernel reports: a title, a line of explanation and the items one by one; with update, a button to update the kernel beside it
 */
export interface KernelNote { tone: 'err' | 'warn' | 'off'; title: string; detail: string; items: string[]; update?: boolean }

/**
 * 启动时读的配置里、重载和保存会拒绝的写法（active 的 problems）：KixDNS 照样读进来在用，下次保存前要改掉。有不认面板配置块的那条时先说
 * 更新内核：不更新的话改什么都存不上。names 给不出（不知道在用的是哪份）时路径照原样
 * What the config read at startup writes that a reload or a save refuses (active's problems): KixDNS read it in and runs it all the same, and
 * it is to be fixed before the next save. With the one about the panel's block, updating the kernel comes first: without it no change can be
 * saved. Without names (when it is unknown which config is in use) the paths stay as they are
 */
export function problemsNote(problems: readonly string[], names: PlaceNames | null, settingName: (key: string) => string): KernelNote | null {
  if (!problems.length) return null
  const { blocked, items } = describeProblems(problems, names, settingName)
  if (blocked) {
    return { tone: 'err', title: PANEL_BLOCK_HINT, detail: items.length ? `更新之前，保存、恢复版本和 Geo\u00a0数据、拦截列表的更新都不会生效。另外还有\u00a0${items.length}\u00a0处下次保存前要改掉：` : '更新之前，保存、恢复版本和 Geo\u00a0数据、拦截列表的更新都不会生效', items, update: true }
  }
  return { tone: 'err', title: `在用的配置有\u00a0${items.length}\u00a0处下次保存前要改掉`, detail: 'KixDNS\u00a0启动时照样读进来了，保存时却不会接受这些写法', items }
}
