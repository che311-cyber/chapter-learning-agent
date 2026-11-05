import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, host: true },
  build: {
    // Phaser 是已知的大型 vendor 块（已单独分包，gzip ≈ 340KB）
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Phaser 体积大且稳定，单独分包利于缓存
        manualChunks: { phaser: ['phaser'] },
      },
    },
  },
})
