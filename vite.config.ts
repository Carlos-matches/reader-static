import { defineConfig } from 'vite';

// 代理目标从环境变量读取（仅本地开发用）。
//
// 注意：这里不写 `process.env`。本项目是浏览器项目，tsconfig 的 types 里
// 声明的是 "vite/client"，而 vite.config.ts 又恰好被 include 进来 —— 一旦
// 某个环境下拿不到 Node 的类型定义（Netlify 的 Linux 构建机就出现过），
// `process` 会被判定为未定义，整个构建以退出码 2 失败。
//
// 用 globalThis 做一次安全取值：本地能读到环境变量，任何环境下都不会
// 因为缺少类型定义而编译失败。
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const PROXY_TARGET = nodeEnv?.PROXY_TARGET ?? 'http://127.0.0.1:9999';

export default defineConfig({
  // 相对路径：这样即使部署在子路径下也能正常工作
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // 把 jszip 一起打进主包，避免额外请求（也便于离线缓存）
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 5173,
    // 开发环境模拟 Netlify 函数：把 /api/proxy 转发到本地函数调试服务。
    // 生产环境由 netlify.toml 的 redirect 指向真正的函数。
    proxy: {
      '/api/proxy': {
        target: PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
});
