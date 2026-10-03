import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Discover worker-only media dependencies before capture, not during the first export.
  optimizeDeps: { include: ['mediabunny', '@mediabunny/aac-encoder'] },
})
