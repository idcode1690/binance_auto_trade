import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set base to the repository name so assets load correctly on GitHub Pages
export default defineConfig({
  // Use relative base so built assets load correctly in both local preview and GitHub Pages.
  // This avoids absolute `/repo/` paths which can break local preview.
  base: './',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/account': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      },
      '/positions': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  }
})
