/**
 * ShopeeSniper Pro — background service worker (MV3)
 *
 * - SSP_INGEST: manda payload pro FastAPI (/ingest/payload) e/ou direto
 *   pro Supabase RPC ingest_shopee_batch.
 * - SSP_DELTA: busca delta de vendas 24h na view vw_sales_by_date_velocity.
 * - SSP_DOWNLOAD: baixa mídia do produto sem marca d'água.
 *
 * Configurar em chrome.storage.local (DevTools > Application ou options page):
 *   backendUrl   (default http://localhost:8000)
 *   supabaseUrl, supabaseKey  (opcional — push direto pro RPC)
 */

const DEFAULTS = { backendUrl: 'http://localhost:8000' };

async function cfg() {
  const c = await chrome.storage.local.get(['backendUrl', 'supabaseUrl', 'supabaseKey']);
  return Object.assign({}, DEFAULTS, c);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'SSP_INGEST') {
    ingest(msg.route, msg.payload).catch(() => {});
    return; // fire & forget
  }

  if (msg.type === 'SSP_INGEST_ITEMS') {
    // itens já normalizados pelo overlay (API + SSR + DOM)
    ingestItems(msg.items || []).catch(() => {});
    return;
  }

  if (msg.type === 'SSP_DELTA') {
    fetchDelta(msg.itemid)
      .then((sales) => sendToTab(sender.tab && sender.tab.id, {
        type: 'SSP_DELTA_RESULT', itemid: msg.itemid, sales
      }))
      .catch(() => sendToTab(sender.tab && sender.tab.id, {
        type: 'SSP_DELTA_RESULT', itemid: msg.itemid, sales: null
      }));
    return;
  }

  if (msg.type === 'SSP_DOWNLOAD') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename })
      .catch(() => {});
    return;
  }
});

function sendToTab(tabId, message) {
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function ingest(route, payload) {
  const c = await cfg();
  // 1) backend FastAPI (normaliza + opcionalmente empurra pro Supabase)
  try {
    await fetch(`${c.backendUrl}/ingest/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route, payload, captured_at: Date.now() / 1000 })
    });
  } catch (e) { /* backend offline — segue pra tentar Supabase direto */ }

  // 2) Supabase direto (se configurado)
  if (c.supabaseUrl && c.supabaseKey) {
    const items = extractForRpc(payload);
    if (!items.length) return;
    await fetch(`${c.supabaseUrl}/rest/v1/rpc/ingest_shopee_batch`, {
      method: 'POST',
      headers: {
        'apikey': c.supabaseKey,
        'Authorization': `Bearer ${c.supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payload: { items } })
    }).catch(() => {});
  }
}

function extractForRpc(p) {
  const data = (p && p.data) || p || {};
  let list = [];
  if (Array.isArray(data.items)) {
    list = data.items.map((i) => i.item_basic || i);
  } else if (data.item) {
    list = [data.item];
  } else if (data.itemid || data.item_id) {
    list = [data];
  }
  return list.filter((i) => i && (i.itemid || i.item_id)).map((i) => ({
    itemid: i.itemid || i.item_id,
    shopid: i.shopid || i.shop_id,
    name: i.name,
    ctime: i.ctime,
    catid: i.catid,
    image: i.image,
    price: i.price,
    stock: i.stock,
    sold_30_days: i.sold,
    historical_sold: i.historical_sold,
    rating_star: (i.item_rating || {}).rating_star,
    rating_count: (i.item_rating || {}).rating_count,
    models: i.models
  }));
}

function mapForRpc(i) {
  return {
    itemid: i.itemid || i.item_id,
    shopid: i.shopid || i.shop_id,
    name: i.name,
    ctime: i.ctime,
    catid: i.catid,
    image: i.image,
    price: i.price || i.price_min,
    stock: i.stock,
    sold_30_days: i.sold || i.sold_30_days,
    historical_sold: i.historical_sold,
    rating_star: (i.item_rating || {}).rating_star || i.rating_star,
    rating_count: (i.item_rating || {}).rating_count || i.rating_count,
    models: i.models
  };
}

async function ingestItems(items) {
  const mapped = items.map(mapForRpc).filter((i) => i.itemid);
  if (!mapped.length) return;
  const c = await cfg();

  console.log(`[ShopeeSniper BG] ingest de ${mapped.length} itens`);

  // 1) backend FastAPI (normaliza + empurra pro Supabase via RPC)
  try {
    const r = await fetch(`${c.backendUrl}/ingest/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route: 'overlay/normalized-items',
        payload: { items: mapped },
        captured_at: Date.now() / 1000
      })
    });
    console.log(`[ShopeeSniper BG] backend /ingest → ${r.status}`);
  } catch (e) {
    console.log('[ShopeeSniper BG] backend offline:', String(e).slice(0, 120));
  }

  // 2) Supabase direto (se configurado)
  if (c.supabaseUrl && c.supabaseKey) {
    try {
      const r = await fetch(`${c.supabaseUrl}/rest/v1/rpc/ingest_shopee_batch`, {
        method: 'POST',
        headers: {
          'apikey': c.supabaseKey,
          'Authorization': `Bearer ${c.supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payload: { items: mapped } })
      });
      if (!r.ok) console.log(`[ShopeeSniper BG] supabase RPC → ${r.status}:`, (await r.text()).slice(0, 200));
      else console.log('[ShopeeSniper BG] supabase RPC → ok');
    } catch (e) {
      console.log('[ShopeeSniper BG] supabase RPC falhou:', String(e).slice(0, 120));
    }
  } else {
    console.log('[ShopeeSniper BG] supabaseUrl/supabaseKey não configurados');
  }
}

async function fetchDelta(itemid) {
  const c = await cfg();
  if (!c.supabaseUrl || !c.supabaseKey) return null;
  const url = `${c.supabaseUrl}/rest/v1/vw_sales_by_date_velocity` +
    `?item_id=eq.${itemid}&order=snapshot_date.desc&limit=1`;
  const resp = await fetch(url, {
    headers: { 'apikey': c.supabaseKey, 'Authorization': `Bearer ${c.supabaseKey}` }
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows.length ? rows[0].sales_on_date : null;
}
