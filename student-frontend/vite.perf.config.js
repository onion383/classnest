// 性能测量专用 Vite 配置：与日常开发配置（vite.config.js）隔离。
// 两种模式：
//   1) 测量服务器模式（默认）：开发端口 +1 跑源码，API 代理到后端端口 +1 的测试后端；
//   2) 预览生产构建：PERF_TARGET=dist，用开发端口 +2 serve 打包产物（无开发态开销，最接近真实手感）。
// 端口可由 PERF_PORT / PERF_BACKEND_PORT 覆盖。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 端口唯一口径：默认值来自 config/ports.cjs，性能测量用「开发端口 + 偏移」避免与日常 dev 抢端口（F07-09）
const ports = require('../config/ports.cjs')

const target = process.env.PERF_TARGET === 'dist' ? 'dist' : 'serve'
const port = Number(process.env.PERF_PORT || (target === 'dist' ? ports.frontendPort + 2 : ports.frontendPort + 1))
const apiTarget = `http://127.0.0.1:${process.env.PERF_BACKEND_PORT || ports.backendPort + 1}`

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/uploads': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/uploads': { target: apiTarget, changeOrigin: true },
    },
  },
  base: './',
})
