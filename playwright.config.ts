import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://127.0.0.1:32001', headless: true },
  webServer: {
    command: 'PORT=32001 NODE_ENV=test V2_EVAL_002_SURFACE=1 ORDER_DB=:memory: STAFF_BOOTSTRAP_CREDENTIAL=test-only-high-entropy-bootstrap node --import tsx src/server.ts',
    url: 'http://127.0.0.1:32001/health',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
