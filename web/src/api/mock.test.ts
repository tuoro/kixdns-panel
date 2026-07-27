import { describe, expect, it } from 'vitest'
import type { ServiceStatus, ValidationResult } from './types'
import { mockRequest } from './mock'

describe('演示 API', () => {
  it('按服务动作更新运行状态', async () => {
    const stopped = await mockRequest<ServiceStatus>('/api/v1/service/stop', { method: 'POST' })
    expect(stopped.active_state).toBe('inactive')
    expect(stopped.main_pid).toBe(0)

    const started = await mockRequest<ServiceStatus>('/api/v1/service/start', { method: 'POST' })
    expect(started.active_state).toBe('active')
    expect(started.main_pid).toBeGreaterThan(0)
  })

  it('使用候选配置统计 Pipeline', async () => {
    const result = await mockRequest<ValidationResult>('/api/v1/config/validate', {
      method: 'POST',
      body: JSON.stringify({ pipelines: [{ id: 'default' }, { id: 'blocked' }] }),
    })
    expect(result.valid).toBe(true)
    expect(result.pipeline_count).toBe(2)
  })
})
