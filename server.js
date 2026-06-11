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
const CF_APP_ID = process.env.CF_APP_ID || '';
const CF_SEC_KEY = process.env.CF_SEC_KEY || '';
const SHEET_URL = process.env.SHEET_URL || '';
const PHOENIX_USER = process.env.PHOENIX_USER || '11036318';
const PHOENIX_PASS = process.env.PHOENIX_PASS || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Surya DTH Server', cf_configured: !!(CF_APP_ID && CF_SEC_KEY), phoenix_configured: !!(PHOENIX_USER && PHOENIX_PASS), time: new Date().toISOString() });
});

// CREATE CASHFREE PAYMENT LINK
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
    console.log('Cashfree link:', data.link_url || data.message);
    if (data.link_url) {
      res.json({ success: true, link_url: data.link_url, link_id: data.link_id });
    } else {
      res.json({ success: false, error: data.message || 'Failed', data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CASHFREE WEBHOOK
app.post('/webhook/cashfree', async (req, res) => {
  console.log('Webhook received type:', req.body?.type);
  res.json({ status: 'received' });
  try {
    const body = req.body;
    const type = body?.type || '';
    let vc = '', rechargeAmt = '', orderId = '', status = '';

    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      status = body?.data?.payment?.payment_status || '';
      orderId = body?.data?.order?.order_id || '';
      vc = body?.data?.order?.order_tags?.vc_number || '';
      rechargeAmt = body?.data?.order?.order_tags?.recharge_amount || '';
    }
    if (type === 'PAYMENT_LINK_EVENT' && body?.data?.link_status === 'PAID') {
      status = 'SUCCESS';
      orderId = body?.data?.order?.order_id || '';
      vc = body?.data?.link_notes?.vc_number || '';
      rechargeAmt = body?.data?.link_notes?.recharge_amount || '';
    }

    console.log('Processing: status=' + status + ' vc=' + vc + ' recharge=' + rechargeAmt);
    if (status === 'SUCCESS' && vc) {
      await triggerRecharge(vc, rechargeAmt, orderId);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
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

// PHOENIX RECHARGE VIA HTTP
function parseCookies(headers) {
  const raw = headers.raw()['set-cookie'] || [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

async function triggerRecharge(vc, amount, orderId) {
  console.log('Phoenix recharge: vc=' + vc + ' amount=' + amount);
  const fetch = require('node-fetch');
  
  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const baseUrl = 'https://phoenix.dishtvbiz.in';
    const loginUrl = baseUrl + '/Account/Login';
    
    // Step 1: Get login page
    const r1 = await fetch(loginUrl, { headers: { 'User-Agent': UA } });
    const html1 = await r1.text();
    const c1 = parseCookies(r1.headers);
    
    const tokenMatch = html1.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    const token = tokenMatch ? tokenMatch[1] : '';
    console.log('Token:', token ? 'found' : 'NOT FOUND');
    
    // Step 2: Login POST
    const loginBody = '__RequestVerificationToken=' + encodeURIComponent(token) +
      '&UserType=2&UserId=' + encodeURIComponent(PHOENIX_USER) +
      '&Password=' + encodeURIComponent(PHOENIX_PASS) +
      '&LoginOption=1';
    
    const r2 = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c1, 'User-Agent': UA, 'Referer': loginUrl },
      body: loginBody,
      redirect: 'manual'
    });
    
    const c2 = parseCookies(r2.headers);
    const allCookies = c1 + '; ' + c2;
    const location = r2.headers.get('location') || '';
    console.log('Login status:', r2.status, 'redirect:', location);
    
    // Step 3: Follow redirect to dashboard
    if (r2.status === 302 && location) {
      const redirectUrl = location.startsWith('http') ? location : baseUrl + location;
      const r3 = await fetch(redirectUrl, {
        headers: { 'Cookie': allCookies, 'User-Agent': UA, 'Referer': loginUrl }
      });
      const c3 = parseCookies(r3.headers);
      const finalCookies = allCookies + '; ' + c3;
      console.log('Redirect status:', r3.status, 'URL:', redirectUrl);
      
      // Step 4: Go to DSD Dashboard (actual landing page after login)
      const dashUrl = baseUrl + '/DSDLHome/DLDSDashboard';
      const r4 = await fetch(dashUrl, {
        headers: { 'Cookie': finalCookies, 'User-Agent': UA, 'Referer': redirectUrl }
      });
      const c4 = parseCookies(r4.headers);
      const sessionCookies = finalCookies + '; ' + c4;
      console.log('Dashboard status:', r4.status);
      const dashHtml = await r4.text();
      console.log('Dashboard has logout:', dashHtml.includes('Logout') || dashHtml.includes('logout'));
      
      // Step 5: Search VC via LCO
      const lcoUrl = baseUrl + '/LCO/LCO';
      const r5 = await fetch(lcoUrl, {
        headers: { 'Cookie': sessionCookies, 'User-Agent': UA, 'Referer': dashUrl }
      });
      const c5 = parseCookies(r5.headers);
      const lcoFinalCookies = sessionCookies + '; ' + c5;
      console.log('LCO page status:', r5.status);
      
      // Step 6: Get VC subscriber data
      const vcSearchUrl = baseUrl + '/LCO/LCO?vcNo=' + vc;
      const r6 = await fetch(vcSearchUrl, {
        headers: { 
          'Cookie': lcoFinalCookies, 
          'User-Agent': UA, 
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': lcoUrl
        }
      });
      const vcData = await r6.text();
      console.log('VC Search status:', r6.status, 'Data:', vcData.substring(0, 200));
    }

    // Update sheet status to SUCCESS
    if (orderId && SHEET_URL) {
      const updateUrl = `${SHEET_URL}?action=updatestatus&order_id=${encodeURIComponent(orderId)}&status=PAYMENT_SUCCESS`;
      await fetch(updateUrl);
      console.log('Sheet status updated to PAYMENT_SUCCESS');
    }

    return { success: true };
  } catch (err) {
    console.error('Phoenix error:', err.message);
    throw err;
  }
}

app.listen(PORT, () => {
  console.log('Surya DTH Server running on port ' + PORT);
  console.log('Phoenix configured: ' + !!(PHOENIX_USER && PHOENIX_PASS));
});
