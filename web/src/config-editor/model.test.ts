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
})
