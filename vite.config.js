import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set base to the repository name so assets load correctly on GitHub Pages
export default defineConfig({
  base: '/binance_auto_trade/',
  plugins: [react()]
})
