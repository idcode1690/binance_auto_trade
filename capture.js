const puppeteer = require('puppeteer');
const http = require('http')
const fs = require('fs')
const path = require('path')

(async()=>{
	try {
		let urlArg = process.argv[2] || 'https://idcode1690.github.io/binance_auto_trade/';
		// if caller passes `local`, start an internal static server serving ./dist
		let server = null
		if (urlArg === 'local') {
			const port = 4730
			const root = path.join(__dirname, 'dist')
			server = http.createServer((req, res) => {
				try {
					let p = decodeURIComponent(req.url.split('?')[0])
					if (p === '/' || p === '') p = '/index.html'
					const filePath = path.join(root, p)
					if (!filePath.startsWith(root)) {
						res.statusCode = 403; res.end('Forbidden'); return
					}
					fs.stat(filePath, (err, st) => {
						if (err) { res.statusCode = 404; res.end('Not found'); return }
						const ext = path.extname(filePath).toLowerCase()
						const map = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'}
						res.setHeader('Content-Type', map[ext] || 'application/octet-stream')
						const stream = fs.createReadStream(filePath)
						stream.pipe(res)
					})
				} catch (e) { res.statusCode = 500; res.end('err') }
			})
			await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (err)=> err ? reject(err) : resolve()))
			urlArg = `http://127.0.0.1:${port}/`
			console.log('Started internal static server at', urlArg)
		}

		const browser = await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox']});
		const page = await browser.newPage();
		const logs = {console:[],errors:[],requests:[],responses:[]};

		page.on('console', msg=>{
			try{ logs.console.push({type:msg.type(),text: msg.text()}); }catch(e){}
		});
		page.on('pageerror', err=>{
			logs.errors.push({type:'pageerror',message: err.message, stack: err.stack});
		});
		page.on('error', err=>{
			logs.errors.push({type:'error',message: err.message, stack: err.stack});
		});
		page.on('requestfailed', req=>{
			const f = req.failure() || {};
			logs.requests.push({url:req.url(),method:req.method(),status:'failed',failure:f.errorText||f});
		});
		page.on('response', async res=>{
			try{
				const status = res.status();
				const url = res.url();
				if(status >= 400) logs.responses.push({url,status});
			}catch(e){}
		});

		try{
			await page.goto(urlArg, {waitUntil:'networkidle2',timeout:30000});
			// give some time for scripts that load after initial idle
			await page.waitForTimeout(2500);
		}catch(e){
			logs.errors.push({type:'navigation',message:e.message, stack: e.stack});
		}

		// capture DOM root content summary
		try{
			const rootInfo = await page.evaluate(()=>{
				const root = document.getElementById('root');
				return root ? {exists:true,childCount: root.children.length,inner: (root.innerText||'').slice(0,500)} : {exists:false};
			});
			logs.root = rootInfo;
		}catch(e){logs.errors.push({type:'evaluate',message:e.message});}

		console.log(JSON.stringify(logs,null,2));
		await browser.close();
		if (server) {
			try { await new Promise(r => server.close(r)) } catch(e){}
		}
		process.exit(0);
	} catch (err) {
		console.error('capture failed', err)
		process.exit(2)
	}
})();

