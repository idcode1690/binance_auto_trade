(async ()=>{
  try {
    const puppeteerMod = await import('puppeteer');
    const puppeteer = puppeteerMod.default || puppeteerMod;
    const http = await import('http');
    const fs = await import('fs');
    const path = await import('path');

    const port = 4780;
    const root = path.join(process.cwd(), 'dist');
    const server = http.createServer((req,res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        const filePath = path.join(root, p);
        if (!filePath.startsWith(root)) { res.statusCode = 403; res.end('Forbidden'); return }
        fs.stat(filePath, (err, st) => {
          if (err) { res.statusCode = 404; res.end('Not found'); return }
          const ext = path.extname(filePath).toLowerCase()
          const map = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'}
          res.setHeader('Content-Type', map[ext] || 'application/octet-stream')
          fs.createReadStream(filePath).pipe(res)
        })
      } catch (e) { res.statusCode = 500; res.end('err') }
    })

    await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (err) => err ? reject(err) : resolve()));
    const url = `http://127.0.0.1:${port}/`;
    console.log('Started server at', url);

    const browser = await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox']});
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    await page.goto(url, {waitUntil: 'networkidle2', timeout: 30000});
    // wait for UI
    await new Promise(r => setTimeout(r, 1500));

    // find button by text and click (evaluate in page context to avoid API differences)
    const clicked = await page.evaluate(()=>{
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => (x.innerText||'').includes('Trigger Test Cross'));
      if (b) { b.click(); return true }
      return false;
    });
    console.log('Clicked?', clicked);

    // wait a moment for state update
    await new Promise(r => setTimeout(r, 500));

    const rootInfo = await page.evaluate(()=>{
      const root = document.getElementById('root');
      const alerts = Array.from(document.querySelectorAll('.alerts .alert-item'))
      return { inner: root ? (root.innerText||'').slice(0,2000) : null, alertCount: alerts.length }
    });

    console.log(JSON.stringify({rootInfo},null,2));

    await browser.close();
    await new Promise(r => server.close(r));
    process.exit(0);
  } catch (err) {
    console.error('error', err);
    process.exit(2);
  }
})();