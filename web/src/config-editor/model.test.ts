import { describe, expect, it } from 'vitest'
import type { KixConfig } from './types'
import {
  applyPipelineSelectMode,
  createAction,
  createEcs,
  createMatcher,
  applyMatcherMode,
  inferMatcherMode,
  inferPipelineSelectMode,
  moveRule,
  normalizeConfig,
  parseConfigSource,
  renamePipeline,
  resetAction,
  resetMatcher,
  serializeConfig,
} from './model'

describe('结构化配置模型', () => {
  it('只在当前 Pipeline 内按目标位置移动规则', () => {
    const config = normalizeConfig({
      pipelines: [{
        id: 'default',
        rules: [
          { name: 'first' },
          { name: 'second' },
          { name: 'third' },
        ],
      }],
    })
    const pipeline = config.pipelines[0]!
    const movedRule = pipeline.rules[1]

    expect(moveRule(pipeline, 1, 0)).toBe(true)
    expect(pipeline.rules.map((rule) => rule.name)).toEqual(['second', 'first', 'third'])
    expect(pipeline.rules[0]).toBe(movedRule)

    expect(moveRule(pipeline, 0, 2)).toBe(true)
    expect(pipeline.rules.map((rule) => rule.name)).toEqual(['first', 'third', 'second'])
  })

  it('拒绝越界或没有产生变化的规则移动', () => {
    const config = normalizeConfig({
      pipelines: [{ id: 'default', rules: [{ name: 'only' }] }],
    })
    const pipeline = config.pipelines[0]!

    expect(moveRule(pipeline, 0, 0)).toBe(false)
    expect(moveRule(pipeline, -1, 0)).toBe(false)
    expect(moveRule(pipeline, 0, 1)).toBe(false)
    expect(pipeline.rules.map((rule) => rule.name)).toEqual(['only'])
  })

  it('规范化必需集合且保留上游未知字段', () => {
    const config = normalizeConfig({
      future_option: { enabled: true },
      settings: { future_setting: 42 },
      pipelines: [{ id: 'default', future_pipeline_field: 'kept' }],
    })

    expect(config.pipeline_select).toEqual([])
    expect(config.pipelines[0]?.rules).toEqual([])
    expect(config.pipelines[0]?.future_pipeline_field).toBe('kept')
    expect(config.settings.future_setting).toBe(42)
    expect(config.future_option).toEqual({ enabled: true })
  })

  it('将国家代码规范化为数组并移除旧版 GeoSite 伪开关', () => {
    const config = normalizeConfig({
      settings: { geosite_enabled: false, geosite_data_paths: ['geosite.dat'] },
      pipelines: [{
        id: 'geo',
        rules: [{
          name: 'country',
          matchers: [{ type: 'geoip_country', country_codes: 'geoip:cn, us' }],
        }],
      }],
    })

    expect(config.settings.geosite_enabled).toBeUndefined()
    expect(config.settings.geosite_data_paths).toEqual(['geosite.dat'])
    expect(config.pipelines[0]?.rules[0]?.matchers[0]?.country_codes).toEqual(['CN', 'US'])
  })

  it('重命名 Pipeline 时同步分流与三个动作阶段的引用', () => {
    const config = normalizeConfig({
      pipeline_select: [{ pipeline: 'old', matchers: [] }],
      pipelines: [
        {
          id: 'old',
          rules: [{
            name: 'r',
            actions: [{ type: 'jump_to_pipeline', pipeline: 'old' }],
            response_actions_on_match: [{ type: 'jump_to_pipeline', pipeline: 'old' }],
            response_actions_on_miss: [{ type: 'jump_to_pipeline', pipeline: 'old' }],
          }],
        },
      ],
    })
    const pipeline = config.pipelines[0]!
    pipeline.id = 'new'

    expect(renamePipeline(config, pipeline, 'old')).toEqual({ id: 'new', references: 4 })
    expect(config.pipeline_select[0]?.pipeline).toBe('new')
    expect(pipeline.rules[0]?.actions[0]?.pipeline).toBe('new')
    expect(pipeline.rules[0]?.response_actions_on_match[0]?.pipeline).toBe('new')
    expect(pipeline.rules[0]?.response_actions_on_miss[0]?.pipeline).toBe('new')
  })

  it('将入口分流的常用关系准确映射到底层逻辑字段', () => {
    const selector = normalizeConfig({
      pipeline_select: [{
        pipeline: 'default',
        matcher_operator: 'or',
        matchers: [
          { type: 'domain_suffix', value: '.cn' },
          { type: 'qtype', value: 'A' },
        ],
      }],
    }).pipeline_select[0]!

    expect(inferPipelineSelectMode(selector)).toBe('any')
    applyPipelineSelectMode(selector, 'all')
    expect(selector.matcher_operator).toBe('and')
    expect(selector.matchers.map((matcher) => matcher.operator)).toEqual(['and', 'and'])

    selector.matchers[1]!.operator = 'and_not'
    expect(inferPipelineSelectMode(selector)).toBe('custom')
    applyPipelineSelectMode(selector, 'any')
    expect(selector.matcher_operator).toBe('or')
    expect(selector.matchers.map((matcher) => matcher.operator)).toEqual(['and', 'and'])
  })

  it('将处理流程的常用条件关系映射为 KixDNS 兼容字段', () => {
    const matchers = [
      createMatcher('request'),
      createMatcher('request'),
    ]

    expect(inferMatcherMode(matchers, 'and')).toBe('all')
    expect(applyMatcherMode(matchers, 'any')).toBe('or')
    expect(matchers.map((matcher) => matcher.operator)).toEqual(['and', 'and'])
    expect(inferMatcherMode(matchers, 'or')).toBe('any')

    matchers[1]!.operator = 'and_not'
    expect(inferMatcherMode(matchers, 'and')).toBe('custom')
    expect(applyMatcherMode(matchers, 'custom')).toBe('and')
    expect(matchers.map((matcher) => matcher.operator)).toEqual(['and', 'and_not'])
  })

  it('切换匹配器和动作类型时清除不兼容字段', () => {
    const matcher = createMatcher('request')
    matcher.cidr = '127.0.0.0/8'
    resetMatcher(matcher, 'qtype', 'request')
    expect(matcher).toEqual({ type: 'qtype', operator: 'and', value: 'A' })

    resetMatcher(matcher, 'geoip_country', 'request')
    expect(matcher.country_codes).toEqual([])

    const action = createAction('forward')
    expect(action).toEqual({ type: 'forward', upstream: '', transport: '' })
    action.ecs = createEcs('static')
    resetAction(action, 'static_response')
    expect(action).toEqual({ type: 'static_response', rcode: 'NXDOMAIN' })

    resetAction(action, 'static_cname_response')
    expect(action).toEqual({ type: 'static_cname_response', target: 'origin.example.', ttl: 300 })
  })

  it('JSON 往返保留嵌套 ECS 并拒绝非对象根节点', () => {
    const source = JSON.stringify({
      settings: {},
      pipelines: [{ id: 'ecs', ecs: { mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 56 }, rules: [] }],
    })
    const parsed = parseConfigSource(source)
    expect(JSON.parse(serializeConfig(parsed)).pipelines[0].ecs).toEqual({ mode: 'from_client_ip', prefix_v4: 24, prefix_v6: 56 })
    expect(() => parseConfigSource('[]')).toThrow('配置根节点必须是 JSON 对象')
  })

  it('按语义顺序序列化已知字段并保留未知字段', () => {
    const config = normalizeConfig({
      future_top: true,
      pipelines: [{
        rules: [{
          response_actions_on_miss: [],
          actions: [{ transport: 'udp', future_action: true, upstream: '1.1.1.1:53', type: 'forward' }],
          name: 'default',
          matchers: [{ value: 'example.com', future_matcher: true, type: 'domain_suffix', operator: 'and' }],
        }],
        future_pipeline: true,
        id: 'default',
      }],
      settings: {
        future_second: 2,
        statistics_enabled: true,
        cache_capacity: 10_000,
        future_first: 1,
        bind_udp: '0.0.0.0:5353',
      },
      version: '1.0',
      pipeline_select: [],
    })
    const serialized = JSON.parse(serializeConfig(config)) as Record<string, unknown>
    const settings = serialized.settings as Record<string, unknown>
    const pipeline = (serialized.pipelines as Array<Record<string, unknown>>)[0]!
    const rule = (pipeline.rules as Array<Record<string, unknown>>)[0]!
    const action = (rule.actions as Array<Record<string, unknown>>)[0]!
    const matcher = (rule.matchers as Array<Record<string, unknown>>)[0]!

    expect(Object.keys(serialized)).toEqual(['version', 'settings', 'pipeline_select', 'pipelines', 'future_top'])
    expect(Object.keys(settings)).toEqual([
      'bind_udp',
      'cache_capacity',
      'statistics_enabled',
      'future_second',
      'future_first',
    ])
    expect(Object.keys(pipeline)).toEqual(['id', 'rules', 'future_pipeline'])
    expect(Object.keys(rule)).toEqual([
      'name',
      'matchers',
      'actions',
      'response_matchers',
      'response_actions_on_match',
      'response_actions_on_miss',
    ])
    expect(Object.keys(matcher)).toEqual(['type', 'value', 'future_matcher'])
    expect(Object.keys(action)).toEqual(['type', 'upstream', 'transport', 'future_action'])
  })

  it('只省略默认 AND 并保留多条件的有效关系', () => {
    const config = normalizeConfig({
      pipeline_select: [
        {
          pipeline: 'cn_doh',
          matchers: [{ type: 'geo_site', value: 'cn' }],
        },
        {
          pipeline: 'global_doh',
          matcher_operator: 'or',
          matchers: [
            { type: 'domain_suffix', value: '.example' },
            { type: 'qtype', value: 'AAAA' },
          ],
        },
        {
          pipeline: 'custom',
          matcher_operator: 'and',
          matchers: [
            { type: 'domain_suffix', operator: 'and', value: '.internal' },
            { type: 'client_ip', operator: 'and_not', cidr: '10.0.0.0/8' },
          ],
        },
      ],
      pipelines: [{
        id: 'default',
        rules: [{
          name: 'default',
          matchers: [{ type: 'any', operator: 'and' }],
          matcher_operator: 'and',
          actions: [],
          response_matchers: [{ type: 'response_rcode', operator: 'or', value: 'NOERROR' }],
          response_matcher_operator: 'and',
        }],
      }],
    })

    const serialized = JSON.parse(serializeConfig(config)) as KixConfig
    expect(serialized.pipeline_select[0]).toEqual({
      pipeline: 'cn_doh',
      matchers: [{ type: 'geo_site', value: 'cn' }],
    })
    expect(serialized.pipeline_select[1]).toEqual({
      pipeline: 'global_doh',
      matchers: [
        { type: 'domain_suffix', value: '.example' },
        { type: 'qtype', value: 'AAAA' },
      ],
      matcher_operator: 'or',
    })
    expect(serialized.pipeline_select[2]).toEqual({
      pipeline: 'custom',
      matchers: [
        { type: 'domain_suffix', value: '.internal' },
        { type: 'client_ip', operator: 'and_not', cidr: '10.0.0.0/8' },
      ],
    })
    expect(serialized.pipelines[0]?.rules[0]).toMatchObject({
      matchers: [{ type: 'any' }],
      response_matchers: [{ type: 'response_rcode', operator: 'or', value: 'NOERROR' }],
    })
    expect(serialized.pipelines[0]?.rules[0]).not.toHaveProperty('matcher_operator')
    expect(serialized.pipelines[0]?.rules[0]).not.toHaveProperty('response_matcher_operator')
  })

  it('自动传输不写入 JSON 并保留显式传输协议', () => {
    const config = normalizeConfig({
      pipelines: [{
        id: 'default',
        rules: [{
          name: 'forward',
          actions: [
            { type: 'forward', upstream: 'doh://dns.example/dns-query' },
            { type: 'forward', upstream: '1.1.1.1:53', transport: 'tcp' },
          ],
        }],
      }],
    })

    expect(config.pipelines[0]?.rules[0]?.actions[0]?.transport).toBe('')
    const actions = JSON.parse(serializeConfig(config)).pipelines[0].rules[0].actions
    expect(actions).toEqual([
      { type: 'forward', upstream: 'doh://dns.example/dns-query' },
      { type: 'forward', upstream: '1.1.1.1:53', transport: 'tcp' },
    ])
  })
})
