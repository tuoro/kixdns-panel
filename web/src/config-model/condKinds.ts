import type { FieldDef, OpDef } from './model'

// 输入时的建议：GeoSite 分类和地区先用固定的常见值（GeoSite 内置之后再从 geo-data 接口拿），记录类型、类别、响应码是 DNS 的固定集合
// Suggestions while typing: GeoSite categories and regions are a fixed list of common values for now (the geo-data API takes over once GeoSite is bundled); record types, classes and rcodes are DNS's own sets
export const GEOSITE_SUGGESTIONS = ['cn', 'geolocation-!cn', 'geolocation-cn', 'category-ads-all', 'apple', 'google', 'microsoft', 'github', 'netflix', 'telegram', 'private']
export const COUNTRY_SUGGESTIONS = ['CN', 'HK', 'TW', 'JP', 'SG', 'US', 'private']
export const QTYPE_SUGGESTIONS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SRV', 'SOA', 'HTTPS', 'SVCB', 'CAA', 'ANY']
export const QCLASS_SUGGESTIONS = ['IN', 'CH', 'HS']
export const RCODE_SUGGESTIONS = ['NOERROR', 'SERVFAIL', 'NXDOMAIN', 'REFUSED', 'FORMERR', 'NOTIMP']

// 条件表单的「添加条件」菜单只列字段（域名、客户端 IP……），按「域名 / 查询 / 客户端」排；「是 / 不是 / 正则」在这一行名字下面的小菜单里改，
// 不再拆成「排除域名」「域名正则」一长串。请求条件（规则的「如果」）和回答条件（「上游回答后」）各一份顺序，表单是同一个。
// The condition form's 添加条件 menu lists fields only (域名, 客户端 IP …), ordered domain / query / client; 是 / 不是 / regex is
// changed in a small menu under the row's name instead of a long list of 「排除域名」「域名正则」 entries. Request conditions (a rule's
// 如果) and answer conditions (上游回答后) each have an order over one shared form.
export interface AnyCond { id: number; field: string; negate: boolean; regex?: boolean; txtMode?: 'exact' | 'prefix' | 'regex'; values: string[] }

export const REQUEST_ORDER = ['domain', 'geosite', 'qtype', 'qclass', 'edns', 'client_ip', 'client_country', 'client_private']
export const RESPONSE_ORDER = ['rcode', 'answer_ip', 'answer_country', 'answer_private', 'answer_type', 'txt', 'upstream', 'upstream_ip', 'request_domain', 'request_geosite', 'qclass', 'edns']

export const SUGGEST: Record<string, readonly string[]> = {
  geosite: GEOSITE_SUGGESTIONS, request_geosite: GEOSITE_SUGGESTIONS, client_country: COUNTRY_SUGGESTIONS, answer_country: COUNTRY_SUGGESTIONS,
  qtype: QTYPE_SUGGESTIONS, answer_type: QTYPE_SUGGESTIONS, qclass: QCLASS_SUGGESTIONS, rcode: RCODE_SUGGESTIONS,
}

// 一个运算落到条件上：是不是排除、是不是正则、TXT 怎么比 / One comparison applied to a condition: whether it excludes, whether it is a regex, how TXT compares
export const opPart = (op: OpDef): Pick<AnyCond, 'negate' | 'regex' | 'txtMode'> => ({ negate: op.negate, regex: Boolean(op.regex), txtMode: op.txtMode })

// 新条件用这个字段的第一种比较（域名「是（含子域名）」、客户端 IP「在」） / A new condition takes the field's first comparison (域名 是（含子域名）, 客户端 IP 在)
export function newOf(field: string, id: number, fields: Record<string, FieldDef>): AnyCond {
  return { id, field, ...opPart(fields[field]!.ops[0]!), values: [] }
}
