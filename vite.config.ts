import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/api/yf': {
        target:       'https://query1.finance.yahoo.com',
        changeOrigin: true,
        secure:       true,
        rewrite:      (path) => path.replace(/^\/api\/yf/, ''),
      },
      '/api/analyze': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/import-screenshot': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/watchlist-signal': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/commentary': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/scenario-simulate': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/historical-prices': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
      '/api/prices': {
        target:       'http://localhost:3333',
        changeOrigin: true,
      },
    },
  },
})
