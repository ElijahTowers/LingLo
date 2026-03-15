const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: 'http://127.0.0.1:3210',
    headless: true,
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'source ~/.nvm/nvm.sh && PORT=3210 node server.js',
    url: 'http://127.0.0.1:3210/login',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
