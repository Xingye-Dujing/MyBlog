import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import fs from 'node:fs'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// public/ 同时被当作网页静态资源和本地开发目录使用，里面混有 Python 虚拟环境、
// PyInstaller 构建产物和数据备份。Vite 会把它们原样复制进 dist/ 并对外发布，
// 既浪费空间（>2 GB）也可能泄露源码与隐私数据。构建后统一剔除。
const DEV_ONLY_DIRS = [
  '.venv',
  '.workbuddy',
  '__pycache__',
  'build',
  'data_back',
  'desktop',
  'dist',
  'mdforge',
]

function stripDevOnlyAssets() {
  return {
    name: 'strip-dev-only-assets',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist')
      for (const name of DEV_ONLY_DIRS) {
        const target = resolve(outDir, name)
        try {
          if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true })
            console.log(`[strip-dev-only-assets] 已剔除 dist/${name}`)
          }
        } catch (err) {
          console.warn(`[strip-dev-only-assets] 无法剔除 dist/${name}:`, err.message)
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), stripDevOnlyAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          highlight: ['highlight.js'],
          katex: ['katex', 'markdown-it-texmath'],
          markdown: ['markdown-it'],
        },
      },
    },
  },
})
