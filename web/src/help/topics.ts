import type { Component } from 'vue'

// 页内帮助的词条和快捷键一览。词条按「这是什么 / 什么时候用 / 内核实际怎么做」三句写，不超过四句；
// 文案里的事实以内核行为为准（GeoSite 按写的分类原样查、备用组只在有回答之后才切、ECS 按管线生效）。
// In-page help topics and the shortcut list. Each topic says what it is, when to use it and what the kernel actually does, in at most four sentences;
// the facts follow kernel behaviour (GeoSite is looked up as written, a fallback only kicks in after a reply, ECS applies per pipeline).
export type HelpPage = 'config' | 'overview' | 'logs' | 'diagnostics' | 'system'

export interface HelpTopic {
  id: string
  /** 标题就是用户在页面上看到的那个词 / The title is the word the user sees on the page */
  title: string
  body: string[]
  page: HelpPage
}

export const HELP_TOPICS: HelpTopic[] = [
  { id: 'after', title: '回答后检查', page: 'config', body: [
    '上游回了答案之后再看一眼：回答里的 IP 落在某个网段、或者是某种返回码时，改问另一个组、拦下或者换一个回答。',
    '只在拿到回答之后才发生。上游超时或连不上不会走到这一步，KixDNS 直接回 SERVFAIL。',
    '「沿用上游组」用这个组里设的备用组；「单独设置」由这条规则自己定条件和去处；「不检查」就是上游回什么返回什么。',
  ] },
  { id: 'ecs', title: '客户端子网（ECS）', page: 'config', body: [
    '把客户端所在的网段附在问上游的请求里，支持 ECS 的上游会回离客户端更近的地址。',
    '「沿用上游组」用上游组里的设置。在规则里单独设了，这条规则会单独占一条管线，缓存也和别的规则分开。',
    '它会把客户端的网段告诉上游；不在意就近的话，通常不需要开。',
  ] },
  { id: 'geosite', title: 'GeoSite 分类', page: 'config', body: [
    '域名分类库里的一类域名，比如 cn 是国内常用域名，category-ads-all 是广告域名。',
    '写什么查什么：分类名按原样在库里找，不会展开或猜测，库里没有这个分类时条件不命中。条件里只写分类名，比如 cn；快速添加里写 geosite:cn 会自动去掉前缀。',
    '库文件在基础设置的 Geo 数据里指定。',
  ] },
  { id: 'groups', title: '规则组', page: 'config', body: [
    '一组单独的规则，写法和主列表一样，从上到下匹配。',
    '两种进来的方式：某条规则的结果选「转到规则组」，或者让这个组直接接住某个监听入口的请求。',
    '适合把一类事情收在一起，比如「孩子的设备」「公司内网」，主列表里只留一条入口。',
  ] },
  { id: 'fallback', title: '备用组', page: 'config', body: [
    '这个组的上游回了 SERVFAIL 或 REFUSED，或者回答落在「结果被污染」后面列出的网段里，就改问另一个组。',
    '只在上游回了答案之后才判断。上游超时或连不上时 KixDNS 直接回 SERVFAIL，不会改问备用组。',
    '怕上游连不上，就在组里多填几个地址：它们同时问，谁先回用谁。',
  ] },
  { id: 'mapping', title: '域名映射', page: 'config', body: [
    '把一个域名直接回成某个 IP，或者回成另一个域名（CNAME），不再去问上游。',
    '子域名也算：映射了 home.arpa，nas.home.arpa 也按它回。',
    '回 IP 时 TTL 固定 300 秒；回域名时默认 300 秒，可以在那一条后面改。',
  ] },
  { id: 'defaults', title: '规则默认值', page: 'config', body: [
    '「拦截时怎么回应」决定规则选「拦截 · 沿用默认」时客户端收到什么：NXDOMAIN 说域名不存在，REFUSED 说拒绝回答，空地址回 0.0.0.0 和 ::。',
    '「其余请求」是没有规则命中时交给哪个上游组，和规则列表最下面那一行是同一个设置。',
  ] },
  { id: 'raw', title: '内核规则', page: 'config', body: [
    '这条规则放不进面板的写法（比如回答阶段先记日志再接着匹配），面板把它原样保留下来。',
    '这里改的就是 KixDNS 直接读的规则，按内核的字段来写；保存前会先交给内核校验。',
    '表单和 JSON 两种写法随时切换；JSON 写错了切不回表单，改好再切。',
  ] },
  { id: 'tester', title: '测试域名', page: 'config', body: [
    '拿一个域名走一遍 KixDNS 正在用的配置，看命中哪条规则、问了哪个上游、回了什么。',
    '测的是已经生效的配置，草稿里没保存的修改不算；保存并热加载之后再测。',
    '请求从面板所在的机器发出，客户端 IP 是这台机器自己（一般是 127.0.0.1），按客户端 IP 分流的规则测不出来。',
  ] },
]

export const helpTopic = (id: string): HelpTopic | undefined => HELP_TOPICS.find((t) => t.id === id)
export const topicsOf = (page: HelpPage): HelpTopic[] => HELP_TOPICS.filter((t) => t.page === page)

// 快捷键：按平台显示 ⌘ 或 Ctrl / Shortcuts: ⌘ or Ctrl by platform
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl'

export interface ShortcutGroup { title: string; items: { keys: string[]; what: string }[] }
export const SHORTCUTS: ShortcutGroup[] = [
  { title: '全站', items: [
    { keys: ['?'], what: '打开帮助和快捷键' },
    { keys: ['Esc'], what: '关闭弹层、抽屉和菜单' },
  ] },
  { title: '配置页', items: [
    { keys: ['/'], what: '搜索规则' },
    { keys: ['n'], what: '新建规则' },
    { keys: [MOD, 'S'], what: '保存草稿' },
  ] },
  { title: '编辑一条规则时', items: [
    { keys: [MOD, '⏎'], what: '完成' },
    { keys: ['Esc'], what: '返回列表' },
  ] },
  { title: '菜单和页签里', items: [
    { keys: ['↑', '↓'], what: '在菜单项之间移动' },
    { keys: ['←', '→'], what: '在页签之间移动' },
    { keys: ['Home', 'End'], what: '跳到第一项 / 最后一项' },
  ] },
]

export type IconComponent = Component
