(async ()=>{
  try {
    const puppeteerMod = await import('puppeteer');
    const puppeteer = puppeteerMod.default || puppeteerMod;
    const http = await import('http');
    const fs = await import('fs');
    const path = await import('path');

    const port = 4790;
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

    const logs = {console:[],errors:[],events:[]};
    page.on('console', msg => logs.console.push({type: msg.type(), text: msg.text()}));
    page.on('pageerror', err => logs.errors.push({type:'pageerror', message: err.message, stack: err.stack}));
    page.on('error', err => logs.errors.push({type:'error', message: err.message}));

    await page.goto(url, {waitUntil: 'networkidle2', timeout: 30000});
    // collect periodic snapshots for 60s
    const snapshots = [];
    const start = Date.now();
    const duration = 60 * 1000; // 60s
    while (Date.now() - start < duration) {
      const snap = await page.evaluate(()=>{
        const alerts = Array.from(document.querySelectorAll('.alerts .alert-item'))
          .map(a=>({text: (a.innerText||'').trim()}));
        const price = document.querySelector('.price') ? (document.querySelector('.price').innerText||'') : null;
        const svgCount = document.querySelectorAll('svg').length;
        return {alertsCount: alerts.length, alerts, price, svgCount, time: Date.now()};
      });
      snapshots.push(snap);
      logs.events.push({t: Date.now(), snapshot: snap});
      // wait 2s between snapshots
      await new Promise(r => setTimeout(r, 2000));
    }

    // final summary
    const final = await page.evaluate(()=>{
      const alerts = Array.from(document.querySelectorAll('.alerts .alert-item'))
        .map(a=>({text: (a.innerText||'').trim()}));
      const price = document.querySelector('.price') ? (document.querySelector('.price').innerText||'') : null;
      const svgCount = document.querySelectorAll('svg').length;
      return {alertsCount: alerts.length, alerts, price, svgCount, time: Date.now()};
    });

    console.log(JSON.stringify({logs, snapshots: snapshots.slice(-10), final}, null, 2));

    await browser.close();
    await new Promise(r => server.close(r));
    process.exit(0);
  } catch (err) {
    console.error('error', err);
    process.exit(2);
  }
})();