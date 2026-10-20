import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  envDir: false, // Never read repository .env files during canonical tests.
  plugins: [react()],
  test: {
    // Frozen BAG release is run only at its historical tag; every assertion
    // remains covered by App-six-raw-release-contract.test.tsx on current raw IDs.
    exclude: [...configDefaults.exclude, 'src/App-release.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: true,
  },
})
