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
const RECHARGE_BOT_URL = process.env.RECHARGE_BOT_URL || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Surya DTH Server', time: new Date().toISOString() });
});

// CREATE CASHFREE PAYMENT LINK
app.post('/create-link', async (req, res) => {
  try {
    const { vc, amount, customer_name, customer_phone, pack_label, recharge_amount, months, company } = req.body;
    if (!vc || !amount) return res.status(400).json({ error: 'VC and amount required' });
    const fetch = require('node-fetch');
    const orderId = 'VC-' + vc + '-' + Date.now();
    const payload = {
      link_id: orderId,
      link_amount: parseFloat(amount),
      link_currency: 'INR',
      link_purpose: 'DTH Recharge - ' + (customer_name || 'Customer') + ' - VC:' + vc,
      customer_details: {
        customer_phone: customer_phone || '9999999999',
        customer_name: customer_name || 'Customer',
        customer_email: 'customer@suryadth.com'
      },
      link_meta: {
        notify_url: 'https://surya-dth.onrender.com/webhook/cashfree',
        return_url: 'https://tvsubbareddy888-blip.github.io/Surya-dth/payment.html?status=success&vc=' + vc
      },
      link_notes: {
        vc_number: vc,
        customer_name: customer_name || '',
        pack: pack_label || '',
        recharge_amount: String(recharge_amount || ''),
        months: String(months || '1'),
        company: company || 'DishTV'
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
    console.log('Cashfree link:', data.link_url || data.message);
    if (data.link_url) {
      res.json({ success: true, link_url: data.link_url, link_id: data.link_id });
    } else {
      res.json({ success: false, error: data.message || 'Failed', data });
    }
  } catch (err) {
    console.error('Create link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CASHFREE WEBHOOK
app.post('/webhook/cashfree', async (req, res) => {
  console.log('Webhook received type:', req.body && req.body.type);
  res.json({ status: 'received' });
  try {
    const body = req.body;
    const type = body && body.type || '';
    let vc = '', rechargeAmt = '', orderId = '', status = '', operator = 'DishTV';

    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      status = body.data && body.data.payment && body.data.payment.payment_status || '';
      orderId = body.data && body.data.order && body.data.order.order_tags && body.data.order.order_tags.link_id || body.data.order.order_id || '';
      vc = body.data && body.data.order && body.data.order.order_tags && body.data.order.order_tags.vc_number || '';
      rechargeAmt = body.data && body.data.order && body.data.order.order_tags && body.data.order.order_tags.recharge_amount || '';
      operator = body.data && body.data.order && body.data.order.order_tags && body.data.order.order_tags.company || 'DishTV';
    }

    if (type === 'PAYMENT_LINK_EVENT' && body.data && body.data.link_status === 'PAID') {
      status = 'SUCCESS';
      orderId = body.data.link_id || body.data.order && body.data.order.order_id || '';
      vc = body.data.link_notes && body.data.link_notes.vc_number || '';
      rechargeAmt = body.data.link_notes && body.data.link_notes.recharge_amount || '';
      operator = body.data.link_notes && body.data.link_notes.company || 'DishTV';
    }

    console.log('Processing: status=' + status + ' vc=' + vc + ' recharge=' + rechargeAmt + ' operator=' + operator);

    if (status === 'SUCCESS' && vc) {
      // Sheet status update
      if (orderId && SHEET_URL) {
        const fetch = require('node-fetch');
        await fetch(SHEET_URL + '?action=updatestatus&order_id=' + encodeURIComponent(orderId) + '&status=PAYMENT_SUCCESS');
        console.log('Sheet status updated to PAYMENT_SUCCESS');
      }
      // Recharge bot call
      await triggerRecharge(vc, rechargeAmt, orderId, operator);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// MANUAL RECHARGE
app.post('/recharge', async (req, res) => {
  const { vc, amount, order_id, company } = req.body;
  if (!vc || !amount) return res.status(400).json({ error: 'VC and amount required' });
  try {
    const result = await triggerRecharge(vc, amount, order_id, company || 'DishTV');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RECHARGE BOT CALL
async function triggerRecharge(vc, amount, orderId, operator) {
  operator = operator || 'DishTV';
  console.log('Recharge bot call: vc=' + vc + ' amount=' + amount + ' operator=' + operator);
  const fetch = require('node-fetch');

  if (!RECHARGE_BOT_URL) {
    console.log('RECHARGE_BOT_URL not set!');
    return { success: false, error: 'Bot URL not configured' };
  }

  const botResp = await fetch(RECHARGE_BOT_URL + '/recharge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vc: vc,
      amount: String(amount),
      operator: operator,
      order_id: orderId || ''
    })
  });

  const botData = await botResp.json();
  console.log('Bot response:', JSON.stringify(botData));

  if (botData.success) {
    if (orderId && SHEET_URL) {
      await fetch(SHEET_URL + '?action=updatestatus&order_id=' + encodeURIComponent(orderId) + '&status=RECHARGED');
      console.log('Sheet updated to RECHARGED');
    }
    return { success: true };
  }

  return { success: false, error: botData.error };
}

app.listen(PORT, () => {
  console.log('Surya DTH Server running on port ' + PORT);
  console.log('Bot URL: ' + (RECHARGE_BOT_URL || 'NOT SET'));
});
