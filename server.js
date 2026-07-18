const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const CF_APP_ID = process.env.CF_APP_ID || '';
const CF_SEC_KEY = process.env.CF_SEC_KEY || '';
const SHEET_URL = process.env.SHEET_URL || '';
const RECHARGE_BOT_URL = process.env.RECHARGE_BOT_URL || '';
const processedOrders = new Set();
const PHOENIX_USERNAME = process.env.PHOENIX_USERNAME || '';
const PHOENIX_PASSWORD = process.env.PHOENIX_PASSWORD || '';
const DISH_PASSWORD = process.env.DISH_PASSWORD || '';
const D2H_PASSWORD = process.env.D2H_PASSWORD || '';

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
      // Duplicate webhook check - ఒకే order_id కి ఒక్కసారి మాత్రమే
      if (orderId && processedOrders.has(orderId)) {
        console.log('Duplicate webhook ignored for order_id: ' + orderId);
        return;
      }
      if (orderId) processedOrders.add(orderId);

      const fetch = require('node-fetch');

      // Sheet లో row ఉందో check చేయి
      if (orderId && SHEET_URL) {
        try {
          const checkRes = await fetch(SHEET_URL + '?action=updatestatus&order_id=' + encodeURIComponent(orderId) + '&status=PAYMENT_SUCCESS');
          const checkData = await checkRes.json();
          console.log('Sheet update result:', JSON.stringify(checkData));

          // Row లేకపోతే కొత్తది create చేయి
          if (checkData.status === 'not_found') {
            console.log('Sheet row not found - creating new row for order: ' + orderId);
            await fetch(SHEET_URL + '?action=save' +
              '&tech=Unknown' +
              '&customer=' + encodeURIComponent(vc) +
              '&mobile=' +
              '&village=' +
              '&vccdsn=' + encodeURIComponent(vc) +
              '&service=Recharge' +
              '&amount=' + encodeURIComponent(rechargeAmt) +
              '&order_id=' + encodeURIComponent(orderId));
            console.log('New row created for order: ' + orderId);
            // తర్వాత PAYMENT_SUCCESS update చేయి
            await fetch(SHEET_URL + '?action=updatestatus&order_id=' + encodeURIComponent(orderId) + '&status=PAYMENT_SUCCESS');
          }
        } catch(e) {
          console.log('Sheet check error:', e.message);
        }
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
      order_id: orderId || '',
      phoenix_username: PHOENIX_USERNAME,
      phoenix_password: PHOENIX_PASSWORD,
      dish_password: DISH_PASSWORD,
      d2h_password: D2H_PASSWORD
    })
  });

  const botData = await botResp.json();
  console.log('Bot response:', JSON.stringify(botData));

  if (orderId && SHEET_URL) {
    const status = botData.success ? 'RECHARGED' : ('PAID-RECHARGE FAILED: ' + (botData.message || botData.error || 'Unknown error'));
    await fetch(SHEET_URL + '?action=updatestatus&order_id=' + encodeURIComponent(orderId) + '&status=' + encodeURIComponent(status));
    console.log('Sheet updated to: ' + status);
  }

  return { success: botData.success, message: botData.message };
}


// ── FIRESTORE PROXY (Auto Renew) ──
const FS_PROJECT = 'surya-dth-crm';
const FS_KEY = 'AIzaSyDJ83sgOZbJCEDYhGCpvlCNdh2-TWAyq-4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents`;

// POST - batch add/remove auto-renew customers
app.post('/autorenew/batch', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { customers, enable } = req.body;
    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({ error: 'customers array required' });
    }
    console.log(`Auto Renew batch: ${enable ? 'ADD' : 'REMOVE'} ${customers.length} customers`);

    // Firestore batch write
    const batchSize = 500;
    let totalSuccess = 0;

    for (let i = 0; i < customers.length; i += batchSize) {
      const chunk = customers.slice(i, i + batchSize);
      let writes;
      if (enable) {
        writes = chunk.map(c => ({
          update: {
            name: `projects/${FS_PROJECT}/databases/(default)/documents/auto-renew-customers/vc_${c.vc}`,
            fields: {
              vc: { stringValue: c.vc },
              name: { stringValue: c.name || '' },
              mobile: { stringValue: c.mobile || '' },
              company: { stringValue: c.company || '' },
              renewal: { stringValue: c.renewal || '' },
              addedAt: { stringValue: new Date().toISOString() }
            }
          }
        }));
      } else {
        writes = chunk.map(c => ({
          delete: `projects/${FS_PROJECT}/databases/(default)/documents/auto-renew-customers/vc_${c.vc}`
        }));
      }

      const batchUrl = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents:commit?key=${FS_KEY}`;
      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      const batchData = await batchRes.json();
      if (batchData.writeResults) {
        totalSuccess += batchData.writeResults.length;
      }
    }

    console.log(`Batch done: ${totalSuccess} processed`);
    // Cache clear చేయి — next request లో fresh data వస్తుంది
    autoRenewCache = [];
    autoRenewCacheTime = 0;
    res.json({ success: true, processed: totalSuccess });
  } catch (e) {
    console.log('Batch error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// POST - batch add VCs only (text paste / excel upload) - using Firestore batch write
app.post('/autorenew/batchvcs', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { vcs } = req.body;
    if (!vcs || !Array.isArray(vcs)) {
      return res.status(400).json({ error: 'vcs array required' });
    }
    console.log(`Auto Renew batchvcs: ADD ${vcs.length} VCs`);

    // Firestore batch write - max 500 per batch
    const batchSize = 500;
    let totalSuccess = 0;

    for (let i = 0; i < vcs.length; i += batchSize) {
      const chunk = vcs.slice(i, i + batchSize);
      const writes = chunk.map(vc => ({
        update: {
          name: `projects/${FS_PROJECT}/databases/(default)/documents/auto-renew-customers/vc_${vc}`,
          fields: {
            vc: { stringValue: vc },
            name: { stringValue: '' },
            mobile: { stringValue: '' },
            company: { stringValue: '' },
            renewal: { stringValue: '' },
            addedAt: { stringValue: new Date().toISOString() }
          }
        }
      }));

      const batchUrl = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents:commit?key=${FS_KEY}`;
      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      const batchData = await batchRes.json();
      if (batchData.writeResults) {
        totalSuccess += batchData.writeResults.length;
        console.log(`Batch ${Math.floor(i/batchSize)+1}: ${batchData.writeResults.length} written`);
      }
    }

    console.log(`BatchVCs done: ${totalSuccess} total written`);
    res.json({ success: true, processed: totalSuccess });
  } catch (e) {
    console.log('BatchVCs error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// POST - save auto renewal recharge to Sheet
app.post('/autorenew/saverecharge', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { vc, name, mobile, tech, company, amount, order_id, status } = req.body;
    if (!SHEET_URL) return res.json({ success: false, error: 'SHEET_URL not set' });

    // Sheet లో row save చేయి
    const saveUrl = SHEET_URL
      + '?action=save'
      + '&tech=' + encodeURIComponent(tech || 'AUTO RENEWAL')
      + '&customer=' + encodeURIComponent(name || '')
      + '&mobile=' + encodeURIComponent(mobile || '')
      + '&village='
      + '&vccdsn=' + encodeURIComponent(vc || '')
      + '&service=Auto Renewal'
      + '&amount=' + encodeURIComponent(amount || '177')
      + '&order_id=' + encodeURIComponent(order_id || '');
    await fetch(saveUrl);

    // Status update చేయి
    const statusUrl = SHEET_URL
      + '?action=updatestatus'
      + '&order_id=' + encodeURIComponent(order_id || '')
      + '&status=' + encodeURIComponent(status || 'RECHARGED');
    await fetch(statusUrl);

    console.log(`Auto Renewal Sheet saved: VC=${vc} status=${status}`);
    res.json({ success: true });
  } catch (e) {
    console.log('Save recharge error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// POST - update lastRecharged after successful recharge
app.post('/autorenew/updaterecharged', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { vc, lastRecharged, lastRenewalDate } = req.body;
    if (!vc) return res.status(400).json({ error: 'VC required' });
    const docId = 'vc_' + vc;
    // First get existing data
    const getRes = await fetch(`${FS_BASE}/auto-renew-customers/${docId}?key=${FS_KEY}`);
    const existing = await getRes.json();
    const existingFields = existing.fields || {};
    // Merge with existing fields
    const updatedFields = {
      ...existingFields,
      lastRecharged: { stringValue: lastRecharged || '' },
      lastRenewalDate: { stringValue: lastRenewalDate || '' }
    };
    const patchRes = await fetch(`${FS_BASE}/auto-renew-customers/${docId}?key=${FS_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: updatedFields })
    });
    const data = await patchRes.json();
    console.log(`Auto Renew lastRecharged updated for VC ${vc}: ${lastRecharged}`);
    res.json({ success: true, data });
  } catch (e) {
    console.log('Firestore updaterecharged error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// DELETE all auto-renew customers
app.delete('/autorenew/all', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    console.log('Removing ALL auto-renew customers...');

    // ముందు అన్ని documents తీసుకో
    let allDocs = [];
    let nextPage = null;
    do {
      const url = `${FS_BASE}/auto-renew-customers?key=${FS_KEY}&pageSize=300${nextPage ? '&pageToken=' + nextPage : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.documents) allDocs = allDocs.concat(data.documents);
      nextPage = data.nextPageToken || null;
    } while (nextPage);

    console.log(`Found ${allDocs.length} documents to delete`);
    if (!allDocs.length) return res.json({ success: true, processed: 0 });

    // Batch delete (500 per batch)
    const batchUrl = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents:commit?key=${FS_KEY}`;
    let totalDeleted = 0;

    for (let i = 0; i < allDocs.length; i += 500) {
      const chunk = allDocs.slice(i, i + 500);
      const writes = chunk.map(doc => ({ delete: doc.name }));
      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      const batchData = await batchRes.json();
      if (batchData.writeResults) totalDeleted += batchData.writeResults.length;
    }

    console.log(`All removed: ${totalDeleted}`);
    res.json({ success: true, processed: totalDeleted });
  } catch (e) {
    console.log('Remove all error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// AUTO RENEW CUSTOMERS CACHE
const fs = require('fs');
const RENEWAL_CACHE_FILE = '/tmp/renewalCache.json';
const PACK_CACHE_FILE = '/tmp/packCache.json';

// File cache నుండి load చేయి
function loadFileCache(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Validate — status field ఉందా check చేయి
      if(Array.isArray(data) && data.length > 0) {
        const sample = data[0];
        if(!('status' in sample)) {
          console.log(`[CACHE] Old format (no status) — deleting: ${filePath}`);
          fs.unlinkSync(filePath);
          return null;
        }
      }
      console.log(`[CACHE] Loaded from file: ${filePath} (${Array.isArray(data) ? data.length : Object.keys(data).length} records)`);
      return data;
    }
  } catch(e) {
    console.log(`[CACHE] File load error: ${e.message}`);
  }
  return null;
}

// File cache లో save చేయి
function saveFileCache(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    console.log(`[CACHE] Saved to file: ${filePath}`);
  } catch(e) {
    console.log(`[CACHE] File save error: ${e.message}`);
  }
}

let autoRenewCache = [];
let autoRenewCacheTime = 0;

// GET all auto-renew customers (with pagination + cache)
app.get('/autorenew', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';
    
    // Cache valid అయితే return చేయి (15 minutes TTL)
    if(!forceRefresh && autoRenewCache.length > 0 && (now - autoRenewCacheTime) < 15 * 60 * 1000) {
      // renewalCache తో merge చేయి
      const customers = autoRenewCache.map(c => {
        let renewal = c.renewal || '';
        let status = c.status || '';
        if(c.vc && renewalCache.length > 0) {
          const cached = renewalCache.find(r => r.vc === c.vc);
          if(cached && cached.renewal) renewal = cached.renewal;
          if(cached && cached.status) status = cached.status;
        }
        return { ...c, renewal, status };
      });
      console.log(`Auto Renew GET: ${customers.length} customers (cache)`);
      return res.json({ success: true, customers });
    }
    
    let allDocs = [];
    let nextPage = null;
    do {
      const url = `${FS_BASE}/auto-renew-customers?key=${FS_KEY}&pageSize=300${nextPage ? '&pageToken=' + nextPage : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if(data.error) {
        // Quota exceeded — cache ఉంటే return చేయి
        if(autoRenewCache.length > 0) {
          console.log(`Auto Renew GET: ${autoRenewCache.length} customers (quota exceeded, using cache)`);
          return res.json({ success: true, customers: autoRenewCache });
        }
        console.log('Auto Renew GET: 0 customers (quota exceeded)');
        return res.json({ success: true, customers: [] });
      }
      if(data.documents) allDocs = allDocs.concat(data.documents);
      nextPage = data.nextPageToken || null;
    } while(nextPage);

    const vcs = [];
    allDocs.forEach(doc => {
      const vc = doc.fields?.vc?.stringValue;
      const name = doc.fields?.name?.stringValue || '';
      const company = doc.fields?.company?.stringValue || '';
      const mobile = doc.fields?.mobile?.stringValue || '';
      
      let renewal = doc.fields?.renewal?.stringValue || '';
      let status = doc.fields?.status?.stringValue || '';
      if(vc && renewalCache.length > 0) {
        const cached = renewalCache.find(r => r.vc === vc);
        if(cached && cached.renewal) renewal = cached.renewal;
        if(cached && cached.status) status = cached.status;
      }
      
      if(vc) vcs.push({ 
        vc, name, renewal, status, company, mobile,
        lastRecharged: doc.fields?.lastRecharged?.stringValue || '',
        lastRenewalDate: doc.fields?.lastRenewalDate?.stringValue || ''
      });
    });
    
    // Cache update చేయి
    if(vcs.length > 0) {
      autoRenewCache = vcs;
      autoRenewCacheTime = now;
    }
    
    console.log(`Auto Renew GET: ${vcs.length} customers`);
    res.json({ success: true, customers: vcs });
  } catch(e) {
    console.log('Firestore GET error:', e.message);
    if(autoRenewCache.length > 0) {
      return res.json({ success: true, customers: autoRenewCache });
    }
    res.json({ success: false, error: e.message });
  }
});

// POST - add/update auto-renew customer
app.post('/autorenew', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { vc, name, mobile, company, renewal } = req.body;
    if (!vc) return res.status(400).json({ error: 'VC required' });
    const docId = 'vc_' + vc;
    const r = await fetch(`${FS_BASE}/auto-renew-customers/${docId}?key=${FS_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        vc: { stringValue: vc },
        name: { stringValue: name || '' },
        mobile: { stringValue: mobile || '' },
        company: { stringValue: company || '' },
        renewal: { stringValue: renewal || '' },
        addedAt: { stringValue: new Date().toISOString() }
      }})
    });
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e) {
    console.log('Firestore POST error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// DELETE - remove auto-renew customer
app.delete('/autorenew/:vc', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const vc = req.params.vc;
    const docId = 'vc_' + vc;
    await fetch(`${FS_BASE}/auto-renew-customers/${docId}?key=${FS_KEY}`, { method: 'DELETE' });
    res.json({ success: true });
  } catch (e) {
    console.log('Firestore DELETE error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// PACK DETAILS CACHE
const PCT_CACHE_FILE = '/tmp/pctCache.json';
let pctCache = loadFileCache(PCT_CACHE_FILE) || {};

let packCache = loadFileCache(PACK_CACHE_FILE) || {};
let packCacheTime = Object.keys(packCache).length > 0 ? Date.now() : 0;
const PACK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 గంటలు

// PACK SYNC — CRM నుండి VCs పంపి VPS bot trigger చేయి
app.post('/packSync', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { dish, d2h } = req.body;
    console.log(`[PACK SYNC] Dish: ${(dish||[]).length}, D2H: ${(d2h||[]).length}`);
    const botRes = await fetch(`${RECHARGE_BOT_URL}/packSync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dish: dish||[], d2h: d2h||[] })
    });
    const data = await botRes.json();
    res.json(data);
  } catch(e) {
    console.log('[PACK SYNC ERROR]', e.message);
    res.json({ success: false, message: e.message });
  }
});

// PACK SYNC SAVE — VPS నుండి Firebase కి save చేయి + cache update
app.post('/packSync/save', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { packs } = req.body;
    console.log(`[PACK SYNC SAVE] ${(packs||[]).length} packs`);
    let saved = 0;
    
    // Cache update చేయి
    (packs||[]).forEach(p => {
      if(p.vc) packCache[p.vc] = p.systemPack || '';
    });
    packCacheTime = Date.now();
    saveFileCache(PACK_CACHE_FILE, packCache);
    console.log(`[PACK SYNC SAVE] Cache updated: ${Object.keys(packCache).length} packs`);
    
    for (const pack of (packs||[])) {
      const vc = pack.vc || '';
      if (!vc) continue;
      const docId = 'vc_' + vc;
      const doc = {
        fields: {
          vc: { stringValue: vc },
          systemPack: { stringValue: pack.systemPack || '' },
          operator: { stringValue: pack.operator || '' },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      };
      try {
        await fetch(`${FS_BASE}/pack-details/${docId}?key=${FS_KEY}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc)
        });
        saved++;
      } catch(e) {
        console.log(`[PACK SAVE] VC ${vc} error:`, e.message);
      }
    }
    console.log(`[PACK SYNC SAVE] ${saved}/${(packs||[]).length} saved`);
    res.json({ success: true, saved, total: (packs||[]).length });
  } catch(e) {
    console.log('[PACK SYNC SAVE ERROR]', e.message);
    res.json({ success: false, message: e.message });
  }
});

// PACK DETAILS GET — CRM లో System Pack చూపించడానికి (cache వాడు)
app.get('/packDetails', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    
    // Cache valid అయితే return చేయి
    if(Object.keys(packCache).length > 0) {
      const packs = Object.entries(packCache).map(([vc, systemPack]) => ({
        vc, systemPack, operator: '', updatedAt: ''
      }));
      console.log(`[PACK DETAILS] Serving from cache: ${packs.length} packs`);
      return res.json({ success: true, packs });
    }
    
    // Cache లేదు — Firebase నుండి load చేయి
    const allPacks = [];
    let pageToken = '';
    do {
      const url = `${FS_BASE}/pack-details?key=${FS_KEY}&pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if(data.error) {
        console.log('[PACK DETAILS] Firebase error:', data.error.message);
        break;
      }
      const docs = data.documents || [];
      docs.forEach(doc => {
        const f = doc.fields || {};
        const vc = f.vc?.stringValue || '';
        const systemPack = f.systemPack?.stringValue || '';
        allPacks.push({ vc, systemPack, operator: f.operator?.stringValue || '', updatedAt: f.updatedAt?.stringValue || '' });
        if(vc) packCache[vc] = systemPack;
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    
    packCacheTime = Date.now();
    console.log(`[PACK DETAILS] Loaded ${allPacks.length} from Firebase`);
    res.json({ success: true, packs: allPacks });
  } catch(e) {
    console.log('[PACK DETAILS ERROR]', e.message);
    res.json({ success: false, packs: [] });
  }
});

// RENEWAL SYNC SAVE — VPS నుండి Firebase కి renewal dates save చేయి
app.post('/renewalSync/save', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { renewals } = req.body;
    console.log(`[RENEWAL SYNC SAVE] ${(renewals||[]).length} renewal dates saving...`);
    
    // Batch గా 200 చొప్పున save చేయి
    const batchSize = 200;
    let saved = 0;
    
    for (let i = 0; i < (renewals||[]).length; i += batchSize) {
      const batch = renewals.slice(i, i + batchSize);
      const promises = batch.map(r => {
        const vc = r.vc || '';
        if (!vc) return Promise.resolve();
        const docId = 'vc_' + vc;
        const doc = {
          fields: {
            vc: { stringValue: vc },
            renewal: { stringValue: r.renewal || '' },
            operator: { stringValue: r.operator || '' },
            updatedAt: { stringValue: new Date().toISOString() }
          }
        };
        return fetch(`${FS_BASE}/renewal-dates/${docId}?key=${FS_KEY}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              vc: { stringValue: vc },
              renewal: { stringValue: r.renewal || '' },
              status: { stringValue: r.status || '' },
              operator: { stringValue: r.operator || '' },
              updatedAt: { stringValue: new Date().toISOString() }
            }
          })
        }).then(() => { saved++; }).catch(e => console.log(`VC ${vc} error:`, e.message));
      });
      await Promise.all(promises);
      console.log(`[RENEWAL SYNC SAVE] Batch ${Math.floor(i/batchSize)+1}: ${saved} saved so far`);
    }
    
    // Cache update చేయి
    if((renewals||[]).length > 0) {
      renewalCache = renewals.map(r => ({
        vc: r.vc || '',
        renewal: r.renewal || '',
        status: r.status || '',
        operator: r.operator || '',
        updatedAt: new Date().toISOString()
      }));
      renewalCacheTime = Date.now();
      saveFileCache(RENEWAL_CACHE_FILE, renewalCache);
      console.log(`[RENEWAL SYNC SAVE] Cache updated: ${renewalCache.length} records`);
    }
    
    console.log(`[RENEWAL SYNC SAVE] ${saved}/${(renewals||[]).length} saved`);
    res.json({ success: true, saved, total: (renewals||[]).length });
  } catch(e) {
    console.log('[RENEWAL SYNC SAVE ERROR]', e.message);
    res.json({ success: false, message: e.message });
  }
});

// RENEWAL DATES CACHE
let renewalCache = loadFileCache(RENEWAL_CACHE_FILE) || [];
let renewalCacheTime = renewalCache.length > 0 ? Date.now() : 0;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 గంటలు

// RENEWAL DATES GET — CRM లో renewal dates చూపించడానికి
app.get('/renewalDates', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const now = Date.now();
    
    // Cache valid అయితే return చేయి
    if(renewalCache.length > 0 && (now - renewalCacheTime) < CACHE_TTL) {
      console.log(`[RENEWAL DATES] Serving from cache: ${renewalCache.length} records`);
      return res.json({ success: true, renewals: renewalCache });
    }
    
    const allRenewals = [];
    let pageToken = '';
    do {
      const url = `${FS_BASE}/renewal-dates?key=${FS_KEY}&pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if(data.error) {
        console.log('[RENEWAL DATES] Firebase error:', data.error.message);
        // Cache ఉంటే పాతది return చేయి
        if(renewalCache.length > 0) {
          return res.json({ success: true, renewals: renewalCache });
        }
        break;
      }
      const docs = data.documents || [];
      docs.forEach(doc => {
        const f = doc.fields || {};
        allRenewals.push({
          vc: f.vc?.stringValue || '',
          renewal: f.renewal?.stringValue || '',
          status: f.status?.stringValue || '',
          operator: f.operator?.stringValue || '',
          updatedAt: f.updatedAt?.stringValue || ''
        });
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    
    // Cache update చేయి
    if(allRenewals.length > 0) {
      renewalCache = allRenewals;
      renewalCacheTime = now;
    }
    
    console.log(`[RENEWAL DATES] Loaded ${allRenewals.length} from Firebase`);
    res.json({ success: true, renewals: allRenewals });
  } catch(e) {
    console.log('[RENEWAL DATES ERROR]', e.message);
    if(renewalCache.length > 0) {
      return res.json({ success: true, renewals: renewalCache });
    }
    res.json({ success: false, renewals: [] });
  }
});

// ── PERCENTAGE GET ──
app.get('/percentages', (req, res) => {
  console.log(`[PERCENTAGES] Serving ${Object.keys(pctCache).length} records`);
  res.json({ success: true, percentages: pctCache });
});

// ── PERCENTAGE SAVE ──
app.post('/percentages/save', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { vcs, pct } = req.body;
    if(!vcs || !pct) return res.json({ success: false, message: 'vcs and pct required' });
    
    let saved = 0;
    for(const vc of vcs) {
      if(!vc) continue;
      // Firebase save
      const doc = {
        fields: {
          vc: { stringValue: vc },
          pct: { doubleValue: parseFloat(pct) },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      };
      try {
        await fetch(`${FS_BASE}/vc-percentages/${vc}?key=${FS_KEY}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc)
        });
        pctCache[vc] = parseFloat(pct);
        saved++;
      } catch(e) {
        console.log(`[PCT] VC ${vc} error:`, e.message);
      }
    }
    saveFileCache(PCT_CACHE_FILE, pctCache);
    console.log(`[PERCENTAGES] ${saved}/${vcs.length} saved`);
    res.json({ success: true, saved, total: vcs.length });
  } catch(e) {
    console.log('[PERCENTAGES] Error:', e.message);
    res.json({ success: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log('Surya DTH Server running on port ' + PORT);
  console.log('Bot URL: ' + (RECHARGE_BOT_URL || 'NOT SET'));
  
  // Startup లో VPS నుండి renewal sync trigger చేయి — cache populate అవ్వాలి
  setTimeout(async () => {
    try {
      if(!RECHARGE_BOT_URL) return;
      const fetch = require('node-fetch');
      console.log('[STARTUP] Triggering renewal sync to populate cache...');
      const res = await fetch(`${RECHARGE_BOT_URL}/renewalSync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeout: 10000
      });
      console.log('[STARTUP] Renewal sync triggered!');
    } catch(e) {
      console.log('[STARTUP] Renewal sync trigger failed:', e.message);
    }
  }, 5000); // 5 seconds తర్వాత trigger
});
