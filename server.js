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

// ── PHOENIX RECHARGE VIA HTTP ──
async function triggerRecharge(vc, amount, orderId) {
  console.log('Triggering Phoenix recharge: vc='+vc+' amount='+amount);
  try {
    const fetch = require('node-fetch');
    
    // Step 1: Get login page
    const loginUrl = 'https://phoenix.dishtvbiz.in/Account/Login';
    const loginResp = await fetch(loginUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const loginHtml = await loginResp.text();
    const cookies = loginResp.headers.get('set-cookie') || '';
    
    // Extract token
    const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    const token = tokenMatch ? tokenMatch[1] : '';
    console.log('Token found:', !!token);
    
    // Step 2: Login
    const loginBody = new URLSearchParams({
      '__RequestVerificationToken': token,
      'UserType': '2',
      'UserId': PHOENIX_USER,
      'Password': PHOENIX_PASS,
      'LoginOption': '1'
    });
    
    const loginPost = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: loginBody.toString(),
      redirect: 'manual'
    });
    
    const loginCookies2 = loginPost.headers.get('set-cookie') || cookies;
    const allCookies = cookies + '; ' + loginCookies2;
    const loginHtml2 = await loginPost.text();
    console.log('Login status:', loginPost.status);
    console.log('Login redirect:', loginPost.headers.get('location') || 'none');
    
    // Step 3: Get LCO page with VC search
    const lcoUrl = 'https://phoenix.dishtvbiz.in/LCO/GetLCOSubscribersByVCNo?vcNo=' + vc;
    const lcoResp = await fetch(lcoUrl, {
      headers: { 'Cookie': allCookies, 'User-Agent': 'Mozilla/5.0' }
    });
    const lcoData = await lcoResp.text();
    console.log('LCO response:', lcoData.substring(0, 200));
    
    // Update sheet status
    if (orderId && SHEET_URL) {
      await fetch(`${SHEET_URL}?action=updatestatus&order_id=${encodeURIComponent(orderId)}&status=PROCESSING`);
    }
    
    return { success: true, message: 'Recharge initiated', loginStatus: loginPost.status };
  } catch (err) {
    console.error('Phoenix recharge error:', err);
    throw err;
  }
}

;
  });
}

app.listen(PORT, () => {
  console.log(`Surya DTH Server running on port ${PORT}`);
  console.log(`Phoenix configured: ${!!(PHOENIX_USER && PHOENIX_PASS)}`);
});
