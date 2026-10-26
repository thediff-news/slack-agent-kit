import { chromium } from 'playwright';
const mode = process.argv[2];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
const out = { mode };
try {
  if (mode === 'home') {
    await page.goto('http://127.0.0.1:5310/', { waitUntil: 'domcontentloaded', timeout: 200000 });
    await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 200000 });
    await page.waitForTimeout(3000);
    out.hydrated = true;
    out.title = await page.title();
    await page.screenshot({ path: '/tmp/hydrate-home.png', fullPage: false });
  } else if (mode === 'token') {
    await page.goto('http://127.0.0.1:5310/token-generator?uppercase=true&lowercase=false&numbers=false&symbols=false&length=512', { waitUntil: 'domcontentloaded', timeout: 200000 });
    await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 200000 });
    await page.waitForTimeout(3000);
    const vals = await page.$$eval('input[readonly], textarea[readonly]', els => els.map(e => e.value));
    out.readonlyLens = vals.map(v => v.length);
    const tok = vals.find(v => v.length >= 500) || '';
    out.tokenLen = tok.length;
    out.hasN = new Set(tok).has('N');
    await page.screenshot({ path: '/tmp/hydrate-token.png', fullPage: false });
  } else if (mode === 'textstats') {
    await page.goto('http://127.0.0.1:5310/text-statistics', { waitUntil: 'domcontentloaded', timeout: 200000 });
    await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 200000 });
    await page.waitForTimeout(2000);
    await page.locator('textarea').first().fill('   \n\t  ');
    await page.waitForTimeout(1200);
    const stats = await page.$$eval('.n-statistic', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    out.stats = stats.slice(0, 6);
    await page.screenshot({ path: '/tmp/hydrate-textstats.png', fullPage: false });
  }
} catch (e) { out.error = String(e).slice(0, 300); }
out.consoleErrors = errors.slice(0, 5);
out.consoleErrorCount = errors.length;
console.log(JSON.stringify(out));
await browser.close();
