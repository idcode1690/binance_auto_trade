const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => {
    try { logs.push({type: msg.type(), text: msg.text()}); } catch(e){}
  });
  page.on('pageerror', err => logs.push({type: 'pageerror', text: String(err)}));
  const url = 'http://localhost:5173/';
  console.log('OPENING', url);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch(e) {
    console.error('NAV_ERR', String(e));
  }

  try {
    await page.waitForSelector('.account-card', { timeout: 7000 });
  } catch (e) {
    // ignore
  }

  const getSnapshot = async () => {
    return await page.evaluate(() => {
      const qs = s => document.querySelector(s);
      const balance = qs('.account-card .account-balance')?.innerText || null;
      const upl = qs('.account-card .upl-amount')?.innerText || null;
      const margin = qs('.account-card .account-row.account-bottom .account-balance')?.innerText || null;
      const position = qs('.positions-table .pnl-amount')?.innerText || null;
      const roi = qs('.positions-table .pnl-percent')?.innerText || null;
      const wsStatus = qs('.hero .hero-sub')?.innerText || null;
      return { balance, upl, margin, position, roi, wsStatus };
    });
  };

  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const snapshots = [];
  for (let i = 0; i < 12; i++) {
    try {
      const snap = await getSnapshot();
      snapshots.push(snap);
    } catch (e) {
      snapshots.push({ error: String(e) });
    }
    await sleep(1000);
  }

  console.log('=== PAGE CONSOLE LOGS ===');
  console.log(JSON.stringify(logs, null, 2));
  console.log('=== DOM SNAPSHOTS ===');
  console.log(JSON.stringify(snapshots, null, 2));

  await browser.close();
})();
