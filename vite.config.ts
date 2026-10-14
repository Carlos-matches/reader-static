import { defineConfig } from 'vite';

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
        target: process.env.PROXY_TARGET ?? 'http://127.0.0.1:9999',
        changeOrigin: true,
      },
    },
  },
});
