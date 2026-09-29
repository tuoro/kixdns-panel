import { describe, expect, it } from 'vitest'
import { actionsPhrase, conditionPhrase, entryNamePhrase, phraseSegments, rulePhrase } from './phrase'
import { serializeConfig } from './model'
import type { KixConfig } from './types'

const code = (segments: ReturnType<typeof phraseSegments>) => segments.filter((segment) => segment.code).map((segment) => segment.text)

describe('句子里的机器值', () => {
  it('地址、Pipeline ID、域名是机器值；分类名、响应码、级别、协议名是词', () => {
    expect(code(phraseSegments(actionsPhrase([{ type: 'forward', upstream: 'https://dns.google/dns-query', transport: 'doh' }]))))
      .toEqual(['https://dns.google/dns-query'])
    expect(code(phraseSegments(actionsPhrase([{ type: 'log', level: 'warn' }, { type: 'jump_to_pipeline', pipeline: 'global_doh' }]))))
      .toEqual(['global_doh'])
    expect(code(phraseSegments(actionsPhrase([{ type: 'static_response', rcode: 'NXDOMAIN' }])))).toEqual([])
    expect(code(phraseSegments(conditionPhrase([{ type: 'domain_suffix', operator: 'and', value: 'example.com' }], 'and', 'request'))))
      .toEqual(['example.com'])
    expect(code(phraseSegments(conditionPhrase([{ type: 'geo_site', operator: 'and', value: 'cn' }], 'and', 'request')))).toEqual([])
  })

  it('几个上游各是一个机器值，用顿号隔开', () => {
    const phrase = actionsPhrase([{ type: 'forward', upstream: 'https://doh.pub/dns-query, https://dns.alidns.com/dns-query' }])
    expect(phrase.text).toBe('转发至 https://doh.pub/dns-query、https://dns.alidns.com/dns-query')
    expect(code(phraseSegments(phrase))).toEqual(['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'])
  })

  it('并成一句的「A、B 或 C」：地址照样等宽，分类名照样是词', () => {
    const cidrs = conditionPhrase([
      { type: 'response_answer_ip', operator: 'and', cidr: '0.0.0.0/32' },
      { type: 'response_answer_ip', operator: 'and', cidr: '240.0.0.0/4' },
    ], 'or', 'response')
    expect(cidrs.text).toBe('应答 IP 属于 0.0.0.0/32 或 240.0.0.0/4')
    expect(code(phraseSegments(cidrs))).toEqual(['0.0.0.0/32', '240.0.0.0/4'])
    const categories = conditionPhrase([
      { type: 'geo_site', operator: 'and', value: 'cn' },
      { type: 'geo_site', operator: 'and', value: 'private' },
    ], 'or', 'request')
    expect(categories.text).toBe('域名属于 GeoSite cn 或 private')
    expect(code(phraseSegments(categories))).toEqual([])
  })

  it('入口的名字不标机器值；给界面整块换行用的标记里有它的值', () => {
    expect(code(phraseSegments(conditionPhrase([{ type: 'client_ip', operator: 'and', cidr: '10.0.0.0/8' }], 'and', 'selector')))).toEqual([])
    expect(code(phraseSegments(entryNamePhrase([{ type: 'geo_site', operator: 'and', value: 'geosite:category-ads-all' }], 'and'))))
      .toEqual(['category-ads-all'])
  })

  it('一条规则是「条件，动作」', () => {
    expect(rulePhrase({ name: 'r', matchers: [], matcher_operator: 'and', actions: [{ type: 'deny' }], response_matchers: [], response_matcher_operator: 'and', response_actions_on_match: [], response_actions_on_miss: [] }).text)
      .toBe('任意请求，拒绝请求')
  })
})

describe('写出配置', () => {
  it('去掉地址框里用来换行的零宽字符', () => {
    const config = {
      version: '1.0',
      settings: { default_upstream: 'https://dns.google/\u200bdns-\u2060query' },
      pipeline_select: [],
      pipelines: [],
    } as unknown as KixConfig
    expect(serializeConfig(config)).toContain('"default_upstream": "https://dns.google/dns-query"')
  })
})
