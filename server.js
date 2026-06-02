const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const EP_USER = process.env.EP_USER || '';
const EP_PASS = process.env.EP_PASS || '';
const SHEET_URL = process.env.SHEET_URL || 'https://script.google.com/macros/s/AKfycbx3acvlnqiyROjlQR_mR1e6k1JeWryithW_jCSMapCB9CUWSzNunQ8Ye8b19BcRb6vf/exec';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Surya DTH Server', ep_configured: !!(EP_USER && EP_PASS) });
});

app.post('/webhook/cashfree', async (req, res) => {
  console.log('Webhook:', JSON.stringify(req.body));
  try {
    const body = req.body;
    const status = body?.data?.payment?.payment_status || body?.type || '';
    const orderId = body?.data?.order?.order_id || body?.order_id || '';
    const amount = body?.data?.payment?.payment_amount || body?.order_amount || 0;
    if (status === 'SUCCESS' || status === 'PAYMENT_SUCCESS') {
      res.json({ status: 'received' });
      const vcData = await getVCFromSheet(orderId);
      if (vcData && vcData.vccdsn) {
        await triggerRecharge(vcData.vccdsn, amount, orderId);
      }
    } else {
      res.json({ status: 'received', message: status });
    }
  } catch (err) {
    res.status(200).json({ status: 'error', message: err.message });
  }
});

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

async function getVCFromSheet(orderId) {
  const fetch = require('node-fetch');
  const res = await fetch(`${SHEET_URL}?action=getdata`);
  const data = await res.json();
  if (data.data) return data.data.find(r => r.order_id === orderId) || null;
  return null;
}

async function triggerRecharge(vc, amount, orderId) {
  const fetch = require('node-fetch');
  const url = `${SHEET_URL}?action=recharge&vc=${encodeURIComponent(vc)}&amount=${amount}&order_id=${encodeURIComponent(orderId||'')}&ep_user=${encodeURIComponent(EP_USER)}&ep_pass=${encodeURIComponent(EP_PASS)}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('Recharge response:', data);
  return { success: true, data };
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
