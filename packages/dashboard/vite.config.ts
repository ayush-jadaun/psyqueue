import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/ui'),
  build: {
    outDir: path.resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:9999',
    },
  },
})
