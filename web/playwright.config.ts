import { defineConfig, devices } from '@playwright/test'

const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 2 : undefined,
  reporter: isCi
    ? [['line'], ['html', { outputFolder: '../playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4185',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      // 手机视口只跑带 @responsive 标记的用例：其余用例在两个视口里断言完全相同，
      // 重跑一遍只是复制桌面结果。新增依赖视口的断言时记得给标题加上这个标记。
      // 设计目标是 375px 宽；按 390 跑会让只在 375 才挤出来的布局问题一路绿灯。
      // The design target is 375px wide; running at 390 let layout breaks that appear only at 375 pass.
      name: 'mobile',
      grep: /@responsive/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4185',
    env: { VITE_DEMO_MODE: 'true' },
    url: 'http://127.0.0.1:4185',
    reuseExistingServer: !isCi,
    timeout: 120_000,
  },
})
