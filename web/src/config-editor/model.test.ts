import { describe, expect, it } from 'vitest'
import {
  createAction,
  createEcs,
  createMatcher,
  normalizeConfig,
  parseConfigSource,
  renamePipeline,
  resetAction,
  resetMatcher,
  serializeConfig,
} from './model'

describe('结构化配置模型', () => {
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

  it('切换匹配器和动作类型时清除不兼容字段', () => {
    const matcher = createMatcher('request')
    matcher.cidr = '127.0.0.0/8'
    resetMatcher(matcher, 'qtype', 'request')
    expect(matcher).toEqual({ type: 'qtype', operator: 'and', value: 'A' })

    resetMatcher(matcher, 'geoip_country', 'request')
    expect(matcher.country_codes).toEqual([])

    const action = createAction('forward')
    action.ecs = createEcs('static')
    resetAction(action, 'static_response')
    expect(action).toEqual({ type: 'static_response', rcode: 'NXDOMAIN' })
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
      'matcher_operator',
      'actions',
      'response_matchers',
      'response_matcher_operator',
      'response_actions_on_match',
      'response_actions_on_miss',
    ])
    expect(Object.keys(matcher)).toEqual(['type', 'operator', 'value', 'future_matcher'])
    expect(Object.keys(action)).toEqual(['type', 'upstream', 'transport', 'future_action'])
  })
})
