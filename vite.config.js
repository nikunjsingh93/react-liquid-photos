import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
      '/thumb': 'http://localhost:5174',
      '/media': 'http://localhost:5174',
      '/download': 'http://localhost:5174'
    }
  }
})