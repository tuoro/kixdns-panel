import type { KernelArg, KernelSaying } from './api/types'
import { negationWords } from './config-editor/field-validation'
import { MATCH_OPERATORS, MATCHER_DEFINITIONS, settingName } from './config-editor/schema'
import { DOH_PATH_PROBLEM, LISTEN_ADDRESS_PROBLEM, hostNameWarning } from './config-editor/settings-checks'
import { QCLASSES, RCODES, qtypeRule } from './config-model/grammar'
import { PREFIX } from './config-model/kernel'
import { ADDRESS_FAULT, LOG_LEVEL_NAME, PROTOCOL_LABEL, RESPONSE_FIELD, UPSTREAM_PREFIXES, type Protocol } from './config-model/model'

// 内核说的每种话（声明 message_codes_v1 的内核起，见内核仓库的 docs/message-codes.md）在面板上怎么说：按代号和参数用面板的叫法讲——规则组、
// 列表、设置、条件、传输都照页面上写的，面板自己的检查说过的同一件事说得一样。认不出的代号、参数对不上的，照内核的英文原话说，标明是原话。
// 这张表要正好覆盖内核的每个代号、参数名对得上：CI 拿最新的内核（main）的代号清单核对（kernel-sayings.test.ts）
// How the panel says each kind of thing the kernel says (from kernels declaring message_codes_v1, see docs/message-codes.md in the kernel
// repository): by the code and the arguments, in the panel's names — rule groups, lists, settings, conditions and transports as the page
// writes them, and anything the panel's own checks say put the same way. A code it does not know, or arguments that do not fit, is said in
// the kernel's English words, marked as such. The table has to cover every code of the kernel exactly with matching argument names: CI
// checks it against the code list of the latest kernel (main) (kernel-sayings.test.ts)

/** 内核的英文原话照原样给，标明是 KixDNS 的原话；pipeline 给得出叫法时，引号里的 Pipeline id 后面补上它 / The kernel's English words as they
 * are, marked as KixDNS's own; where pipeline can name it, a quoted pipeline id is followed by its name */
export function kernelSaid(words: string, pipeline?: (id: string) => string | null): string {
  const named = pipeline ? words.replace(/"([\w.-]+)"/g, (whole, id: string) => { const name = pipeline(id); return name ? `${whole}（${name}）` : whole }) : words
  return `KixDNS\u00a0的原话：${named}`
}

// 参数的几种样子：文字（配置里写的值、路径、库和系统给的错误，还有匹配器种类、传输这些固定的词）、数、文字的列表、套着的另一种话（原因）
// The shapes of an argument: text (a value the config writes, a path, an error a library or the system gives, and fixed words such as a
// matcher kind or a transport), a number, a list of text, another saying held within (a reason)
type Kind = 'text' | 'number' | 'list' | 'said'
type Arg<K extends Kind> = { text: string; number: number; list: readonly string[]; said: KernelSaying }[K]
const fits: Record<Kind, (value: KernelArg | undefined) => boolean> = {
  text: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  list: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  said: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.code === 'string' && typeof value.text === 'string' && typeof value.args === 'object',
}

/** 说一种话时手边的：Pipeline id 怎么叫，套着的原因怎么说 / What is at hand when saying one: how a pipeline id is called, how a reason within is said */
interface Tell {
  pipeline: (id: string) => string
  said: (saying: KernelSaying) => string
}
/** 一种话：参数名和样子，和怎么说 / One kind of saying: its argument names and shapes, and how it is said */
export interface Saying {
  readonly args: Readonly<Record<string, Kind>>
  readonly say: (args: Readonly<Record<string, KernelArg>>, tell: Tell) => string
}
// 参数照写的样子给到说法里；说之前先核对过样子（sayKernel） / The arguments reach the words in the shapes written, checked before saying (sayKernel)
const saying = <const A extends Record<string, Kind>>(args: A, say: (a: { [N in keyof A]: Arg<A[N]> }, tell: Tell) => string): Saying => ({ args, say: say as Saying['say'] })

// 条件、传输、运算符、Geo 数据文件照页面上的叫法；页面上没有的照写内核的词 / Conditions, transports, operators and Geo data files as the page
// names them; one the page lacks keeps the kernel's word
const MATCHER_NAMES = new Map(Object.values(MATCHER_DEFINITIONS).flat().map((matcher) => [matcher.value, matcher.label]))
const matcher = (kind: string): string => `「${MATCHER_NAMES.get(kind) ?? kind}」`
const transport = (name: string): string => PROTOCOL_LABEL[PREFIX[name] as Protocol] ?? name
const operator = (name: string): string => MATCH_OPERATORS.find((item) => item.value === name)?.label ?? name
const TXT_MODES = RESPONSE_FIELD.txt.ops.filter((op) => !op.negate)
const txtMode = (mode: string): string => TXT_MODES.find((op) => op.txtMode === mode)?.label ?? mode
// 内核的 Geo 数据文件种类是哪个设置写的路径；叫法和 Geo 数据那一栏一样 / The setting writing the path of each kind of Geo data file the kernel
// names; called as in the Geo data section
const GEO_SETTINGS: Record<string, string> = { geosite: 'geosite_data_paths', geoip: 'geoip_dat_path', mmdb: 'geoip_db_path' }
const geoFile = (file: string): string => (GEO_SETTINGS[file] ? settingName(GEO_SETTINGS[file]) : file)
const tags = (list: readonly string[]): string => list.join('、')
const because = (error: string): string => `（原因：${error}）`
const written = (value: string | number): string => `，写的是「${value}」`
const GEO_SITE_NEVER = `${matcher('geo_site')}永远不命中，${matcher('geo_site_not')}总是命中`
const GEO_IP_NEVER = `${matcher('geoip_country')}永远不命中`

/** 每个代号的说法，按内核 src/notice.rs 里的顺序 / The words for each code, in the order of the kernel's src/notice.rs */
export const SAYINGS: Readonly<Record<string, Saying>> = {
  // 上游地址：默认上游和规则里的转发写的 / Upstream addresses: those the default upstream and the forwards of rules write
  no_upstream: saying({}, () => '一个上游地址都没写，问它的请求都会失败；至少填一个地址'),
  upstream_unknown_prefix: saying({ upstream: 'text', prefix: 'text' }, (a) => `上游 ${a.upstream} 的前缀「${a.prefix}://」认不出：${UPSTREAM_PREFIXES}`),
  upstream_unusable: saying({ upstream: 'text', reason: 'said' }, (a, tell) => `上游 ${a.upstream} 用不了：${tell.said(a.reason)}`),
  default_upstream_over: saying({ transport: 'text', problem: 'said' }, (a, tell) => `没写上游，问的是默认上游；经 ${transport(a.transport)} 问时，${tell.said(a.problem)}`),
  bootstrap_server_unusable: saying({ server: 'text', reason: 'said' }, (a, tell) => `引导 DNS ${a.server} 用不了：${tell.said(a.reason)}`),

  // 上游地址为什么用不了：上面几种话的原因，说法和面板检查上游地址时一样 / Why an upstream address cannot be used: the reasons of the sayings above,
  // in the words the panel's own check of upstream addresses uses
  address_not_ip_port: saying({ error: 'text' }, (a) => `要写成「IP:端口」，比如 223.5.5.5:53${because(a.error)}`),
  port_zero: saying({}, () => ADDRESS_FAULT.port('')),
  address_not_host_port: saying({}, () => ADDRESS_FAULT['host-port']('')),
  port_invalid: saying({ error: 'text' }, (a) => `${ADDRESS_FAULT.port('')}${because(a.error)}`),
  host_invalid: saying({ host: 'text' }, (a) => `${ADDRESS_FAULT.host('')}${written(a.host)}`),
  doh_second_prefix: saying({ prefix: 'text' }, (a) => `${ADDRESS_FAULT['second-prefix']('DoH')}${written(`${a.prefix}://`)}`),
  doh_url_invalid: saying({ error: 'text' }, (a) => `${ADDRESS_FAULT.url('DoH')}${because(a.error)}`),
  tls_server_name_invalid: saying({ error: 'text' }, (a) => `${ADDRESS_FAULT['server-name']('')}${because(a.error)}`),
  second_prefix: saying({ prefix: 'text' }, (a) => `${ADDRESS_FAULT['second-prefix']('')}${written(`${a.prefix}://`)}`),
  tls_url_invalid: saying({ transport: 'text', error: 'text' }, (a) => `${ADDRESS_FAULT.url(transport(a.transport))}${because(a.error)}`),
  tls_host_missing: saying({ transport: 'text' }, (a) => `${transport(a.transport)} 的地址没写主机`),
  tls_path_given: saying({ transport: 'text' }, (a) => ADDRESS_FAULT.path(transport(a.transport))),
  zero_rtt_invalid: saying({ key: 'text', value: 'text' }, (a) => `${ADDRESS_FAULT['0rtt']('')}，写的是 ${a.key}=${a.value}`),
  tls_parameter_unknown: saying({ transport: 'text', key: 'text' }, (a) => `${ADDRESS_FAULT.param(transport(a.transport))}，不认「${a.key}」`),
  doq_ip_needs_sni: saying({}, () => ADDRESS_FAULT.sni('')),

  // 设置：说的那个设置是位置，说法和设置页框下面的一样 / Settings: the setting spoken of is the place, in the words under its box on the settings page
  doh_path_without_slash: saying({ path: 'text' }, (a) => `${DOH_PATH_PROBLEM}${written(a.path)}`),
  setting_over_limit: saying({ value: 'number', most: 'number' }, (a) => `最多 ${a.most}${written(a.value)}；KixDNS 启动时按 ${a.most} 用，保存时不收`),
  listen_address_invalid: saying({ value: 'text', error: 'text' }, (a) => `${LISTEN_ADDRESS_PROBLEM}${written(a.value)}${because(a.error)}`),
  doh_setting_missing: saying({ bind_doh: 'text' }, (a) => `写了 ${settingName('bind_doh')}（${a.bind_doh}）就要写这一项`),
  cache_capacity_zero: saying({}, () => '填大于 0 的整数：0 让缓存一条回答也存不下'),
  cache_max_ttl_zero: saying({}, () => '填大于 0 的整数：0 把缓存的每条回答的 TTL 都压成 0，缓存等于没用'),
  refresh_threshold_too_high: saying({ value: 'number' }, (a) => `填 0 到 99 之间的整数：${a.value} 让每次命中缓存都去上游刷新`),
  upstream_timeout_zero: saying({}, () => '填大于 0 的整数：0 让每个上游请求一发出就超时'),
  dashmap_shards_invalid: saying({ value: 'number', most: 'number' }, (a) => `填 0（自动），或者 2 到 ${a.most} 之间 2 的幂（2、4、8……）${written(a.value)}`),
  doq_idle_timeout_too_long: saying({ value: 'number' }, (a) => `${a.value} 秒超过了 QUIC 装得下的上限`),
  request_timeout_below_upstream: saying({ value: 'number', upstream: 'number' }, (a) => `不能小于${settingName('upstream_timeout_ms')}（${a.upstream} 毫秒）${written(`${a.value} 毫秒`)}`),

  // 入口、列表和规则 / Entries, lists and rules
  select_pipeline_missing: saying({ pipeline: 'text' }, (a) => `要进的组「${a.pipeline}」不存在`),
  negation_on_first: saying({ operator: 'text', matchers: 'text' }, (a) => negationWords(a.matchers === 'response_matchers', operator(a.operator))),
  pipeline_id_repeated: saying({ times: 'number', id: 'text' }, (a) => `${a.times} 个列表都叫「${a.id}」：只有第一个起作用，其余的规则从不执行；在 JSON 里改掉重名的再保存`),
  key_not_read: saying({}, () => 'KixDNS 不读这个键，写了也不起作用：看看是不是拼错了，或者写错了地方'),
  forward_ecs_differ: saying({}, () => '这条规则的几个转发合成一次转发、只发一个 ECS，可它们的 ECS 设置不一样，结果哪个都不发；每个写一样的 ECS，或者拆成几条规则'),
  ecs_ip_not_ip: saying({ ip: 'text' }, (a) => `固定子网的 IP「${a.ip}」不是 IP 地址：不设子网，客户端自己带的 ECS（有的话）照样发给上游；固定子网写成 203.0.113.0/24 这样`),
  rcode_unknown: saying({ rcode: 'text' }, (a) => `固定响应码「${a.rcode}」不对：KixDNS 只认 ${RCODES.join('、')}`),
  static_ip_invalid: saying({ ip: 'text' }, (a) => `固定 IP「${a.ip}」写得不对，几个 IP 用逗号隔开`),
  cname_target_invalid: saying({ target: 'text' }, (a) => `CNAME 目标域名「${a.target}」写得不对`),
  txt_no_string: saying({}, () => 'TXT 至少要有一段，空的也行'),
  txt_segment_too_long: saying({ bytes: 'number', most: 'number' }, (a) => `每段 TXT 最长 ${a.most} 字节，有一段 ${a.bytes} 字节`),
  txt_too_long: saying({ bytes: 'number', most: 'number' }, (a) => `TXT 内容在记录里占 ${a.bytes} 字节（每段另算一个长度字节），一份回答最多放得下 ${a.most} 字节`),
  log_level_unknown: saying({ level: 'text' }, (a) => `日志级别「${a.level}」不对：KixDNS 只认 ${Object.keys(LOG_LEVEL_NAME).join('、')}`),
  jump_target_missing: saying({ pipeline: 'text' }, (a) => `要转到的组「${a.pipeline}」不存在`),

  // 条件写的值：说法和条件表单的一样 / The values conditions write, in the words of the condition form
  matches_every_name: saying({ matcher: 'text', value: 'text' }, (a) => `${matcher(a.matcher)}写的是「${a.value}」，对每个域名都成立`),
  matches_only_root: saying({ matcher: 'text' }, (a) => `${matcher(a.matcher)}空着只命中根域名；要指根域名就写「.」`),
  txt_empty_matches_every_answer: saying({ mode: 'text' }, (a) => `${matcher('response_txt_content')}「${txtMode(a.mode)}」空着，对每份带 TXT 记录的回答都成立`),
  response_rcode_unknown: saying({ rcode: 'text' }, (a) => `响应码「${a.rcode}」不对：KixDNS 只认 ${RCODES.join('、')}，其余的响应码写 OTHER`),
  never_matches: saying({ matcher: 'text', value: 'text' }, (a) => `${matcher(a.matcher)}写的是「${a.value}」，永远不命中`),
  no_country_code: saying({ matcher: 'text' }, (a) => `${matcher(a.matcher)}一个国家代码也没写，永远不命中`),
  regex_capitals: saying({ matcher: 'text', pattern: 'text', capitals: 'list' }, (a) => `${matcher(a.matcher)}的正则「${a.pattern}」里，${a.capitals.map((capital) => `「${capital}」`).join('、')}永远命不中：规则看到的域名都是小写；改成小写，或者放在 (?i) 后面`),

  // 编译不了的条件 / Conditions that do not compile
  listener_label_outside_select: saying({}, () => `${matcher('listener_label')}只能用在入口上，规则里用不了`),
  network_invalid: saying({ value: 'text', error: 'text' }, (a) => `「${a.value}」不是网段，网段写成 192.168.1.0/24 这样${because(a.error)}`),
  regex_too_long: saying({ bytes: 'number', most: 'number' }, (a) => `正则最长 ${a.most} 字节，这个有 ${a.bytes} 字节`),
  regex_invalid: saying({ error: 'text' }, (a) => `正则写得不对，或者编译出来太大${because(a.error)}`),
  txt_regex_invalid: saying({ error: 'text' }, (a) => `${matcher('response_txt_content')}的正则写得不对，或者编译出来太大${because(a.error)}`),
  qclass_unknown: saying({ qclass: 'text' }, (a) => `查询类别「${a.qclass}」不对：KixDNS 只认 ${QCLASSES.join('、')}`),
  qtype_unknown: saying({ qtype: 'text' }, (a) => `记录类型「${a.qtype}」不对：KixDNS 只认 ${qtypeRule()}`),
  txt_mode_unknown: saying({ mode: 'text' }, (a) => `${matcher('response_txt_content')}的比较方式「${a.mode}」不对：只认 ${TXT_MODES.map((op) => `${op.txtMode}（${op.label}）`).join('、')}`),

  // 照样生效、却值得知道的 / What takes effect all the same yet is worth knowing
  background_refresh_rule_unused: saying({}, () => '不起作用：后台刷新照原来的请求重走它自己的规则；这一项可以删掉'),
  setting_retired: saying({}, () => '不再起作用的旧设置：KixDNS 照常加载，只是不起作用；清掉再保存就不提醒了'),
  cache_capacity_large: saying({ value: 'number' }, (a) => `${a.value} 条很大，可能占掉很多内存`),
  request_timeout_short: saying({ value: 'number', upstream: 'number' }, (a) => `${a.value} 毫秒不到${settingName('upstream_timeout_ms')}（${a.upstream} 毫秒）的两倍半，可能来不及重发和改用 TCP`),
  jump_cycle: saying({ target: 'text', back_to: 'text' }, (a, tell) => `转到${tell.pipeline(a.target)}以后会绕回${tell.pipeline(a.back_to)}：一直绕圈的请求跳满「${settingName('response_jump_limit')}」就回 SERVFAIL，回答阶段每跳一次还要再问一次上游`),
  geosite_tags_without_data: saying({ tags: 'list' }, (a) => `没写，GeoSite 分类 ${tags(a.tags)} 没有数据可比：${GEO_SITE_NEVER}`),
  geoip_tags_without_data: saying({ tags: 'list' }, (a) => `没写，${settingName('geoip_db_path')}也没写，GeoIP 标签 ${tags(a.tags)} 没有数据可比：${GEO_IP_NEVER}`),
  geoip_tags_beyond_mmdb: saying({ tags: 'list' }, (a) => `没写，${settingName('geoip_db_path')}只有两个字母的国家代码，GeoIP 标签 ${tags(a.tags)} 没有数据可比：${GEO_IP_NEVER}`),
  host_names_without_bootstrap: saying({ host: 'text' }, (a) => hostNameWarning(a.host)),

  // Geo 数据眼下的问题，没有位置 / What is wrong with the Geo data right now, with no place
  data_file_missing: saying({ file: 'text', path: 'text' }, (a) => `${geoFile(a.file)} ${a.path} 不存在`),
  data_file_unreadable: saying({ file: 'text', path: 'text', error: 'text' }, (a) => `${geoFile(a.file)} ${a.path} 读不了${because(a.error)}`),
  data_file_tags_gone: saying({ file: 'text', path: 'text', tags: 'list' }, (a) => `${geoFile(a.file)} ${a.path} 里已经没有规则用到的标签了；之前从它读到的 ${tags(a.tags)} 的数据接着用，等它再变`),
  data_watch_failed: saying({ file: 'text', error: 'text' }, (a) => `${geoFile(a.file)}监视不了：改了要等 KixDNS 重启，或者重载改了要读的文件、规则用到的标签，才读进来${because(a.error)}`),
  data_file_partly_watched: saying({ file: 'text', path: 'text', error: 'text' }, (a) => `${geoFile(a.file)} ${a.path} 有些地方监视不了，改在那里的要等 KixDNS 每\u00a010\u00a0秒一次的核对才读进来${because(a.error)}`),
  geosite_tags_unprovided: saying({ tags: 'list' }, (a) => `GeoSite 分类 ${tags(a.tags)} 哪个文件里都没有：${GEO_SITE_NEVER}`),
  geoip_tags_unprovided: saying({ tags: 'list' }, (a) => `GeoIP 标签 ${tags(a.tags)} 哪份 GeoIP 数据里都没有：${GEO_IP_NEVER}`),
}

/**
 * 内核说的一种话用面板的话说；代号认不出、参数的名字或样子对不上（内核改了这种话）时为 null，由调用的照原话说。pipeline 给 Pipeline id 的叫法，
 * 给不出时照写 id。套着的原因一样说，认不出时照它的原话
 * One kind of thing the kernel says, in the panel's words; null when the code is unknown or the arguments' names or shapes do not fit (the
 * kernel changed that saying), the caller then saying the words. pipeline names a pipeline id, the id written as it is when it cannot. A
 * reason within is said the same way, by its words when unknown
 */
export function sayKernel(said: KernelSaying, pipeline?: (id: string) => string | null): string | null {
  const known = Object.hasOwn(SAYINGS, said.code) ? SAYINGS[said.code]! : null
  if (!known || !Object.entries(known.args).every(([name, kind]) => fits[kind](said.args[name]))) return null
  const tell: Tell = {
    pipeline: (id) => pipeline?.(id) ?? `「${id}」`,
    said: (reason) => sayKernel(reason, pipeline) ?? kernelSaid(reason.text, pipeline),
  }
  return known.say(said.args, tell)
}
