import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': 'http://127.0.0.1:5738',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // 字体永远输出成文件，不内联成 data:：服务端 CSP 是 default-src 'self'，data: 字体会被挡掉。
    // Fonts are always emitted as files, never inlined as data: — the server's CSP
    // (default-src 'self') blocks data: fonts.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined),
  },
  test: {
    environment: 'node',
    exclude: ['e2e/**'],
  },
})
