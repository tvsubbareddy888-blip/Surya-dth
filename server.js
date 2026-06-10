const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const EP_USER = process.env.EP_USER || '';
const EP_PASS = process.env.EP_PASS || '';
const CF_APP_ID = process.env.CF_APP_ID || '';
const CF_SEC_KEY = process.env.CF_SEC_KEY || '';
const SHEET_URL = process.env.SHEET_URL || '';
const PHOENIX_USER = process.env.PHOENIX_USER || '11036318';
const PHOENIX_PASS = process.env.PHOENIX_PASS || '';

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Surya DTH Server',
    cf_configured: !!(CF_APP_ID && CF_SEC_KEY),
    ep_configured: !!(EP_USER && EP_PASS),
    phoenix_configured: !!(PHOENIX_USER && PHOENIX_PASS),
    time: new Date().toISOString() 
  });
});

// ── CREATE CASHFREE PAYMENT LINK ──
app.post('/create-link', async (req, res) => {
  try {
    const { vc, amount, customer_name, customer_phone, pack_label, recharge_amount, months } = req.body;
    if (!vc || !amount) return res.status(400).json({ error: 'VC and amount required' });
    const fetch = require('node-fetch');
    const orderId = 'VC-' + vc + '-' + Date.now();
    const payload = {
      link_id: orderId,
      link_amount: parseFloat(amount),
      link_currency: 'INR',
      link_purpose: 'DTH Recharge - ' + (customer_name||'Customer') + ' - VC:' + vc,
      customer_details: { customer_phone: customer_phone || '9999999999', customer_name: customer_name || 'Customer', customer_email: 'customer@suryadth.com' },
      link_meta: { notify_url: 'https://surya-dth.onrender.com/webhook/cashfree', return_url: 'https://tvsubbareddy888-blip.github.io/Surya-dth/payment.html?status=success&vc=' + vc },
      link_notes: { vc_number: vc, customer_name: customer_name || '', pack: pack_label || '', recharge_amount: String(recharge_amount || ''), months: String(months || '1') }
    };
    const cfRes = await fetch('https://api.cashfree.com/pg/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-version': '2023-08-01', 'x-client-id': CF_APP_ID, 'x-client-secret': CF_SEC_KEY },
      body: JSON.stringify(payload)
    });
    const data = await cfRes.json();
    console.log('Cashfree link response:', JSON.stringify(data));
    if (data.link_url) {
      res.json({ success: true, link_url: data.link_url, link_id: data.link_id });
    } else {
      res.json({ success: false, error: data.message || 'Link creation failed', data });
    }
  } catch (err) {
    console.error('Create link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CASHFREE WEBHOOK ──
app.post('/webhook/cashfree', async (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body));
  res.json({ status: 'received' });
  
  try {
    const body = req.body;
    const type = body?.type || '';
    
    let vc = '';
    let rechargeAmt = '';
    let orderId = '';
    let status = '';

    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      status = body?.data?.payment?.payment_status || '';
      orderId = body?.data?.order?.order_id || '';
      vc = body?.data?.order?.order_tags?.vc_number || '';
      rechargeAmt = body?.data?.order?.order_tags?.recharge_amount || '';
    }
    
    if (type === 'PAYMENT_LINK_EVENT') {
      const linkStatus = body?.data?.link_status || '';
      if (linkStatus === 'PAID') {
        status = 'SUCCESS';
        orderId = body?.data?.order?.order_id || '';
        vc = body?.data?.link_notes?.vc_number || '';
        rechargeAmt = body?.data?.link_notes?.recharge_amount || '';
      }
    }

    console.log(`Processing: type=${type} status=${status} vc=${vc} recharge=${rechargeAmt}`);

    if (status === 'SUCCESS' && vc) {
      await triggerRecharge(vc, rechargeAmt, orderId);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// Manual recharge
app.post('/recharge', async (req, res) => {
  const { vc, amount, order_id } = req.body;
  if (!vc || !amount) return res.status(400).json({ error: 'VC and amount required' });
  try {
    const result = await triggerRecharge(vc, amount, order_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PHOENIX RECHARGE VIA PUPPETEER ──
async function triggerRecharge(vc, amount, orderId) {
  console.log('Triggering Phoenix recharge: vc='+vc+' amount='+amount);
  try {
    const puppeteer = require('puppeteer');
    
    // Chrome executable path — Render cache location
    const chromePaths = [
      '/opt/render/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome',
      '/opt/render/.cache/puppeteer/chrome/linux-122.0.6261.94/chrome-linux64/chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ];
    
    const fs = require('fs');
    let executablePath = null;
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { executablePath = p; break; }
    }
    
    if (!executablePath) {
      // Try to find any chrome in cache
      const cacheDir = '/opt/render/.cache/puppeteer/chrome';
      if (fs.existsSync(cacheDir)) {
        const dirs = fs.readdirSync(cacheDir);
        for (const d of dirs) {
          const p = `${cacheDir}/${d}/chrome-linux64/chrome`;
          if (fs.existsSync(p)) { executablePath = p; break; }
        }
      }
    }
    
    console.log('Chrome path:', executablePath || 'NOT FOUND');
    
    if (!executablePath) {
      throw new Error('Chrome not found! Run: npx puppeteer browsers install chrome');
    }
    
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });
    
    const page = await browser.newPage();
    await page.setDefaultTimeout(30000);
    
    // Step 1: Login
    console.log('Phoenix: Opening login page...');
    await page.goto('https://phoenix.dishtvbiz.in/Account/Login', { waitUntil: 'networkidle2' });
    
    // Select Trade Partner
    await page.select('select[name="UserType"]', '2').catch(() => {
      console.log('UserType select failed, trying alternate...');
    });
    
    // Enter User ID
    await page.type('input[name="UserId"]', PHOENIX_USER);
    
    // Select Password login
    const passwordRadio = await page.$('input[value="1"][type="radio"]');
    if (passwordRadio) await passwordRadio.click();
    
    await page.waitForTimeout(500);
    
    // Enter Password
    await page.type('input[name="Password"]', PHOENIX_PASS);
    
    // Submit login
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    console.log('Phoenix: Login done, URL: ' + page.url());
    
    // Step 2: Go to LCO Dashboard
    await page.goto('https://phoenix.dishtvbiz.in/LCO/LCO', { waitUntil: 'networkidle2' });
    
    // Step 3: Search by VC
    console.log('Phoenix: Searching VC...');
    const vcInput = await page.$('input[placeholder*="VC"], input[name*="vc"], input[name*="VC"], input[id*="vc"]');
    if (vcInput) {
      await vcInput.type(vc);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
    }
    
    // Step 4: Click Instant Recharge
    const rechargeBtn = await page.$x('//a[contains(text(),"Instant Recharge")]');
    if (rechargeBtn.length > 0) {
      await rechargeBtn[0].click();
      await page.waitForTimeout(2000);
    }
    
    // Step 5: Enter amount
    const amountInput = await page.$('input[name*="Amount"], input[id*="Amount"]');
    if (amountInput) {
      await amountInput.click({ clickCount: 3 });
      await amountInput.type(String(amount));
    }
    
    // Step 6: Submit
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForTimeout(3000);
    
    const pageContent = await page.content();
    console.log('Phoenix: Recharge result: ' + pageContent.substring(0, 200));
    
    await browser.close();
    
    // Update sheet
    if (orderId && SHEET_URL) {
      const fetch = require('node-fetch');
      await fetch(`${SHEET_URL}?action=updatestatus&order_id=${encodeURIComponent(orderId)}&status=RECHARGED`);
    }
    
    return { success: true, message: 'Recharge triggered' };
  } catch (err) {
    console.error('Phoenix recharge error:', err);
    throw err;
  }
}

async function installChrome() {
  try {
    const { execSync } = require('child_process');
    console.log('Installing Chrome...');
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    console.log('Chrome installed!');
  } catch(err) {
    console.log('Chrome install error:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Surya DTH Server running on port ${PORT}`);
  console.log(`Phoenix configured: ${!!(PHOENIX_USER && PHOENIX_PASS)}`);
  // Install Chrome in background — server not blocked
  installChrome().then(() => {
    console.log('Chrome ready!');
  }).catch(err => {
    console.log('Chrome install failed:', err.message);
  });
});
