const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const authFile = path.join(__dirname, '.auth', 'user.json');

const viewports = [
  { name: 'phone-small', width: 360, height: 640 },
  { name: 'phone-large', width: 430, height: 932 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'desktop-narrow', width: 1280, height: 800 },
  { name: 'desktop-wide', width: 1536, height: 960 }
];

function getPassword() {
  if (process.env.LINGLO_PASSWORD) return process.env.LINGLO_PASSWORD;
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const match = env.match(/^LINGLO_PASSWORD=(.*)$/m);
  if (!match) throw new Error('LINGLO_PASSWORD not found in .env');
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

async function login(page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill(getPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openFixture(page, scenario, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`/reader.html?fixture=layout&scenario=${scenario}`);
  if (page.url().includes('/login')) {
    await login(page);
    await page.goto(`/reader.html?fixture=layout&scenario=${scenario}`);
  }
  await page.waitForSelector('body[data-fixture-ready="true"]');
  await expect(page.locator('#word-view')).toBeVisible();
}

async function expectButtonsInsideSidebar(page) {
  const metrics = await page.evaluate(() => {
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return [...document.querySelectorAll('.sidebar-actions button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        sidebarLeft: sidebar.left,
        sidebarRight: sidebar.right,
        sidebarTop: sidebar.top,
        sidebarBottom: sidebar.bottom
      };
    });
  });

  for (const button of metrics) {
    expect(button.left).toBeGreaterThanOrEqual(button.sidebarLeft - 1);
    expect(button.right).toBeLessThanOrEqual(button.sidebarRight + 1);
    expect(button.top).toBeGreaterThanOrEqual(button.sidebarTop - 1);
    expect(button.bottom).toBeLessThanOrEqual(button.sidebarBottom + 1);
  }
}

test.use({ storageState: authFile });

test.describe('reader layout fixtures', () => {
  test.beforeAll(async ({ browser }) => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    const page = await browser.newPage({ storageState: undefined });
    await login(page);
    await page.context().storageState({ path: authFile });
    await page.close();
  });

  for (const viewport of viewports) {
    test(`explain overflow remains reachable on ${viewport.name}`, async ({ page }) => {
      await openFixture(page, 'explain', viewport);

      await expect(page.locator('#sidebar')).toHaveScreenshot(`reader-explain-${viewport.name}.png`);
      await expectButtonsInsideSidebar(page);

      const metrics = await page.evaluate(() => {
        const panel = document.getElementById('panel-translate');
        const model = document.getElementById('explain-model');
        panel.scrollTop = 0;
        panel.scrollTop = panel.scrollHeight;
        const panelRect = panel.getBoundingClientRect();
        const modelRect = model.getBoundingClientRect();
        return {
          clientHeight: panel.clientHeight,
          scrollHeight: panel.scrollHeight,
          modelBottom: modelRect.bottom,
          panelBottom: panelRect.bottom,
          bottomGap: panelRect.bottom - modelRect.bottom
        };
      });

      expect(metrics.scrollHeight).toBeGreaterThanOrEqual(metrics.clientHeight);
      expect(metrics.modelBottom).toBeLessThanOrEqual(metrics.panelBottom + 1);
      expect(metrics.bottomGap).toBeGreaterThanOrEqual(16);
    });

    test(`phrase layout stays reachable on ${viewport.name}`, async ({ page }) => {
      await openFixture(page, 'phrase', viewport);

      await expect(page.locator('#sidebar')).toHaveScreenshot(`reader-phrase-${viewport.name}.png`);

      const metrics = await page.evaluate(() => {
        const panel = document.getElementById('panel-translate');
        const target = document.getElementById('sentence-translation');
        panel.scrollTop = 0;
        panel.scrollTop = panel.scrollHeight;
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          clientHeight: panel.clientHeight,
          scrollHeight: panel.scrollHeight,
          targetBottom: targetRect.bottom,
          panelBottom: panelRect.bottom,
          bottomGap: panelRect.bottom - targetRect.bottom
        };
      });

      expect(metrics.scrollHeight).toBeGreaterThanOrEqual(metrics.clientHeight);
      expect(metrics.targetBottom).toBeLessThanOrEqual(metrics.panelBottom + 1);
      expect(metrics.bottomGap).toBeGreaterThanOrEqual(16);
      await expectButtonsInsideSidebar(page);
      await expect(page.getByRole('button', { name: /save phrase/i })).toBeVisible();
    });
  }
});
