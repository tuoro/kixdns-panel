import type { MatcherConfig } from './types'

// 条件列表和字段校验共用：字段名既写在窄屏的控件旁边，也用在「请填写…」里（审计第五轮 B3）
// Shared by the condition list and field validation: the field name labels the control in a narrow container and names it in 请填写… (audit round 5, B3)
export interface MatcherHint { label: string; example: string; help?: string }
// 每种类型的短字段名（窄屏上写在控件左边）和占位符；只有占位符说不清的才留一句提示（规范 4.2）。
// A short field name per type (shown beside the control in a narrow container) and a placeholder;
// a hint remains only where the placeholder cannot carry it (spec 4.2).
const matcherHints: Record<string, MatcherHint> = {
  listener_label: { label: '标签', example: '监听标签' },
  domain_suffix: { label: '域名', example: 'example.com' },
  request_domain_suffix: { label: '域名', example: 'example.com' },
  domain_regex: { label: '正则', example: '^api\\.example\\.com\\.?$', help: '正则里的点要写成 \\.' },
  request_domain_regex: { label: '正则', example: '^api\\.example\\.com\\.?$', help: '正则里的点要写成 \\.' },
  qtype: { label: '类型', example: 'A' },
  qclass: { label: '类别', example: 'IN' },
  response_qclass: { label: '类别', example: 'IN' },
  upstream_equals: { label: '上游', example: '192.168.1.1:53' },
  response_type: { label: '类型', example: 'A' },
  response_rcode: { label: '响应码', example: 'NXDOMAIN' },
  response_txt_content: { label: '文本', example: 'v=spf1' },
  client_ip: { label: '网段', example: '192.168.1.0/24, 10.0.0.0/8' },
  response_upstream_ip: { label: '网段', example: '192.168.1.0/24' },
  response_answer_ip: { label: '网段', example: '0.0.0.0/32, 240.0.0.0/4' },
}

export function matcherHint(matcher: MatcherConfig): MatcherHint {
  if (matcher.type.includes('geo_site') || matcher.type.includes('geosite')) return { label: '分类', example: '分类名，如 cn' }
  if (matcher.type.includes('geoip_country')) return { label: '国家', example: 'CN, US', help: '需要已导入的 GeoIP 数据' }
  return matcherHints[matcher.type] ?? { label: '值', example: '' }
}
