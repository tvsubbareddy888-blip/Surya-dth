const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — browser నుండి access కోసం
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

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Surya DTH Auto Recharge Server',
    ep_configured: !!(EP_USER && EP_PASS),
    cf_configured: !!(CF_APP_ID && CF_SEC_KEY),
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
      customer_details: {
        customer_phone: customer_phone || '9999999999',
        customer_name: customer_name || 'Customer',
        customer_email: 'customer@suryadth.com'
      },
      link_meta: {
        notify_url: 'https://surya-dth.onrender.com/webhook/cashfree',
        return_url: 'https://lucky-swan-e72bbe.netlify.app/payment.html?status=success&vc=' + vc
      },
      link_notes: {
        vc_number: vc,
        customer_name: customer_name || '',
        pack: pack_label || '',
        recharge_amount: String(recharge_amount || ''),
        months: String(months || '1')
      }
    };

    const cfRes = await fetch('https://api.cashfree.com/pg/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': CF_APP_ID,
        'x-client-secret': CF_SEC_KEY
      },
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
  try {
    const body = req.body;
    const status = body?.data?.payment?.payment_status || body?.type || '';
    const orderId = body?.data?.order?.order_id || body?.data?.link?.link_id || body?.order_id || '';
    const amount = body?.data?.payment?.payment_amount || body?.order_amount || 0;

    console.log(`Payment: status=${status} order=${orderId} amount=${amount}`);

    if (status === 'SUCCESS' || status === 'PAYMENT_SUCCESS') {
      res.json({ status: 'received', message: 'Processing recharge' });
      // Sheet నుండి VC తీసుకో
      const vcData = await getVCFromSheet(orderId);
      if (vcData && vcData.vccdsn) {
        await triggerRecharge(vcData.vccdsn, vcData.amount || amount, orderId, vcData.customer);
      } else {
        // link_notes నుండి VC తీసుకో
        const vc = body?.data?.link?.link_notes?.vc_number || '';
        const rAmt = body?.data?.link?.link_notes?.recharge_amount || amount;
        if (vc) {
          await triggerRecharge(vc, rAmt, orderId, body?.data?.customer?.customer_name || '');
        }
      }
    } else {
      res.json({ status: 'received', message: 'Payment status: ' + status });
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).json({ status: 'error', message: err.message });
  }
});

// Manual recharge
app.post('/recharge', async (req, res) => {
  const { vc, amount, order_id, customer } = req.body;
  if (!vc || !amount) return res.status(400).json({ error: 'VC and amount required' });
  try {
    const result = await triggerRecharge(vc, amount, order_id, customer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get VC from Sheet
async function getVCFromSheet(orderId) {
  try {
    const fetch = require('node-fetch');
    const res = await fetch(`${SHEET_URL}?action=getdata`);
    const data = await res.json();
    if (data.data) return data.data.find(r => r.order_id === orderId) || null;
  } catch (err) {
    console.error('Sheet fetch error:', err);
  }
  return null;
}

// Trigger recharge via GAS
async function triggerRecharge(vc, amount, orderId, customer) {
  try {
    const fetch = require('node-fetch');
    const url = `${SHEET_URL}?action=recharge&vc=${encodeURIComponent(vc)}&amount=${amount}&order_id=${encodeURIComponent(orderId||'')}&ep_user=${encodeURIComponent(EP_USER)}&ep_pass=${encodeURIComponent(EP_PASS)}`;
    const res = await fetch(url);
    const data = await res.json();
    console.log('Recharge response:', data);
    return { success: true, data };
  } catch (err) {
    console.error('Recharge error:', err);
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`Surya DTH Server running on port ${PORT}`);
  console.log(`CF configured: ${!!(CF_APP_ID && CF_SEC_KEY)}`);
  console.log(`EP configured: ${!!(EP_USER && EP_PASS)}`);
});
