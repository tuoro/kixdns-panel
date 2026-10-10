import { describe, expect, it } from 'vitest'
import { actionFieldErrors, GEOSITE_PREFIX_ERROR, isRequiredFieldError, matcherFieldErrors, validDnsName } from './field-validation'

describe('配置字段共享校验', () => {
  it('按条件的实际字段检查必填值，错误说出字段名，并保留未知类型', () => {
    expect(matcherFieldErrors({ type: 'domain_suffix', operator: 'and', value: '  ' }, 'request'))
      .toEqual({ value: '请填写域名' })
    expect(matcherFieldErrors({ type: 'response_answer_ip', operator: 'and' }, 'response'))
      .toEqual({ cidr: '请填写网段' })
    expect(matcherFieldErrors({ type: 'geoip_country', operator: 'and', country_codes: [' '] }, 'selector'))
      .toEqual({ country_codes: '请填写国家' })
    expect(matcherFieldErrors({ type: 'geo_site', operator: 'and', value: '' }, 'selector')).toEqual({ value: '请填写分类' })
    expect(matcherFieldErrors({ type: 'qtype', operator: 'and', value: '' }, 'request')).toEqual({ value: '请选择类型' })
    expect(matcherFieldErrors({ type: 'edns_present', operator: 'and', expect: false }, 'request')).toEqual({})
    expect(matcherFieldErrors({ type: 'future_matcher', operator: 'and' }, 'request')).toEqual({})
  })

  it('GeoSite 分类带 geosite: 前缀时报错：内核按原样查标签，匹配不上', () => {
    for (const type of ['geo_site', 'geo_site_not']) {
      expect(matcherFieldErrors({ type, operator: 'and', value: 'geosite:cn' }, 'selector')).toEqual({ value: GEOSITE_PREFIX_ERROR })
      expect(matcherFieldErrors({ type, operator: 'and', value: 'GeoSite:category-ads-all' }, 'request')).toEqual({ value: GEOSITE_PREFIX_ERROR })
      expect(matcherFieldErrors({ type, operator: 'and', value: 'cn' }, 'request')).toEqual({})
    }
    for (const type of ['response_request_domain_geosite', 'response_request_domain_geosite_not']) {
      expect(matcherFieldErrors({ type, operator: 'and', value: 'geosite:cn' }, 'response')).toEqual({ value: GEOSITE_PREFIX_ERROR })
    }
    // 别的条件里的 geosite: 字样不算 / geosite: in any other condition is left alone
    expect(matcherFieldErrors({ type: 'domain_suffix', operator: 'and', value: 'geosite:cn' }, 'request')).toEqual({})
  })


  it('缺失 CNAME 目标只报告必填错误，非法目标报告格式错误', () => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: ' ' }, 'default'))
      .toEqual({ target: '请填写目标域名' })
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'bad target' }, 'default'))
      .toEqual({ target: 'CNAME 目标域名格式无效' })
  })

  it('动作的必填参数按动作列表里的字段名报错，拉丁字母前留一个空格（审计第五轮 B3）', () => {
    expect(actionFieldErrors({ type: 'forward', upstream: '' }, 'default')).toEqual({ upstream: '请填写上游' })
    expect(actionFieldErrors({ type: 'static_ip_response', ip: ' ' }, 'default')).toEqual({ ip: '请填写 IP' })
    // 必填错误靠开头的「请填写」「请选择」认出来，别的错误不算 / Required errors are told by their 请填写 / 请选择 opening; no other error is
    expect(['请填写域名', '请选择 Pipeline'].every(isRequiredFieldError)).toBe(true)
    expect([GEOSITE_PREFIX_ERROR, 'CNAME 目标域名格式无效', '不能跳转到当前 Pipeline', '目标 Pipeline 不存在'].some(isRequiredFieldError)).toBe(false)
  })

  it('DNS 名称按 UTF-8 字节检查标签与总长度，支持结尾根点', () => {
    expect(validDnsName(' origin.example. ')).toBe(true)
    expect(validDnsName('a..example')).toBe(false)
    expect(validDnsName('.')).toBe(false)
    expect(validDnsName(`${'a'.repeat(63)}.example`)).toBe(true)
    expect(validDnsName(`${'a'.repeat(64)}.example`)).toBe(false)
    expect(validDnsName(`${'中'.repeat(21)}.example`)).toBe(true)
    expect(validDnsName(`${'中'.repeat(22)}.example`)).toBe(false)
    expect(validDnsName([63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.'))).toBe(true)
    expect(validDnsName([63, 63, 63, 62].map((length) => 'a'.repeat(length)).join('.'))).toBe(false)
  })

  it.each([undefined, 0, 300, 4_294_967_295])('CNAME TTL 接受有效边界 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl }, 'default')).toEqual({})
  })

  it.each([-1, 1.5, 4_294_967_296, Number.NaN, Number.POSITIVE_INFINITY])('CNAME TTL 拒绝无效值 %s', (ttl) => {
    expect(actionFieldErrors({ type: 'static_cname_response', target: 'origin.example.', ttl }, 'default'))
      .toEqual({ ttl: 'CNAME TTL 必须是 0 到 4294967295 的整数' })
  })

  it('区分未选择、自跳转、目标不存在；省略列表时不猜测目标是否存在', () => {
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: '' }, 'default', ['default']))
      .toEqual({ pipeline: '请选择 Pipeline' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'default' }, 'default', ['default']))
      .toEqual({ pipeline: '不能跳转到当前 Pipeline' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'removed' }, 'default', ['default']))
      .toEqual({ pipeline: '目标 Pipeline 不存在' })
    expect(actionFieldErrors({ type: 'jump_to_pipeline', pipeline: 'fallback' }, 'default')).toEqual({})
  })

  it('TXT 必须包含有效文本，未知动作不被前端误判', () => {
    expect(actionFieldErrors({ type: 'static_txt_response', text: [' ', ''] }, 'default'))
      .toEqual({ text: '请填写文本' })
    expect(actionFieldErrors({ type: 'replace_txt_response', text: 'v=spf1' }, 'default')).toEqual({})
    expect(actionFieldErrors({ type: 'future_action', future_field: 'keep' }, 'default')).toEqual({})
  })

})
