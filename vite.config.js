import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set base to the repository name so assets load correctly on GitHub Pages
export default defineConfig({
  // Use relative base so built assets load correctly in both local preview and GitHub Pages.
  // This avoids absolute `/repo/` paths which can break local preview.
  base: './',
  plugins: [react()]
})
