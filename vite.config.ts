import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 约定端口 1420，strictPort 避免端口漂移导致 Tauri 连不上
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
})
