const puppeteer = require('puppeteer');
(async()=>{
  const url = process.argv[2] || 'https://idcode1690.github.io/binance_auto_trade/';
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
    await page.goto(url, {waitUntil:'networkidle2',timeout:30000});
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
  process.exit(0);
})();
