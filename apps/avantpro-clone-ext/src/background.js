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

// supabaseUrl/supabaseKey = projeto + anon key (pública por design; a
// proteção real é o RLS + RPC SECURITY DEFINER). Sobrescrevíveis via
// chrome.storage.local se precisar apontar pra outro projeto.
const DEFAULTS = {
  backendUrl: 'http://localhost:8000',
  supabaseUrl: 'https://uiaryvsqcaevatfkxuop.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpYXJ5dnNxY2FldmF0Zmt4dW9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MzAwMDMsImV4cCI6MjEwNzUwNjAwM30.FmfaMw2e0UgViAhzIPapCxlnNDizq_ajx6tdXjccElY'
};

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

  if (msg.type === 'SSP_TRACK') {
    // upsert/delete de item trackado no Supabase (sync entre PCs)
    syncTrack(msg.item).catch(() => {});
    return;
  }

  if (msg.type === 'SSP_TRACK_LIST') {
    fetchTracked()
      .then((list) => sendToTab(sender.tab && sender.tab.id, {
        type: 'SSP_TRACK_RESULT', items: list
      }))
      .catch(() => sendToTab(sender.tab && sender.tab.id, {
        type: 'SSP_TRACK_RESULT', items: []
      }));
    return;
  }

  if (msg.type === 'SSP_OPEN_TABS') {
    // ritual diário do 📌: abre cada PDP em aba de fundo com delay —
    // chrome.tabs.create ignora popup blocker, e o espaçamento deixa a
    // página carregar get_pc antes da próxima abrir (gentil c/ anti-bot)
    (msg.urls || []).slice(0, 20).forEach((u, i) => {
      setTimeout(() => {
        chrome.tabs.create({ url: u, active: false }).catch(() => {});
      }, i * 1200);
    });
    return;
  }
});

function sendToTab(tabId, message) {
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// backend FastAPI é opcional (Supabase direto basta). Quando offline,
// pausa 60s entre sondas — evita spam de "Failed to fetch" na Network
let backendDownUntil = 0;
async function postBackend(body) {
  if (Date.now() < backendDownUntil) return;
  const c = await cfg();
  try {
    await fetch(`${c.backendUrl}/ingest/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    backendDownUntil = Date.now() + 60000;
  }
}

async function ingest(route, payload) {
  const c = await cfg();
  // 1) backend FastAPI (normaliza + opcionalmente empurra pro Supabase)
  await postBackend({ route, payload, captured_at: Date.now() / 1000 });

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

// Shopee manda alguns campos numéricos como array — o RPC faz cast
// pra INTEGER/BIGINT e explode. Normaliza aqui antes de enviar.
function scalar(v, idx) {
  if (Array.isArray(v)) v = v[idx];
  if (v === undefined || v === null || v === '') return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function mapForRpc(i) {
  return {
    itemid: i.itemid || i.item_id,
    shopid: scalar(i.shopid || i.shop_id, 0),
    name: i.name,
    ctime: scalar(i.ctime, 0),
    catid: scalar(i.catid, i.catid && i.catid.length - 1), // path → folha
    image: i.image,
    price: scalar(i.price || i.price_min, 0),
    stock: scalar(i.stock, 0),
    sold_30_days: scalar(i.sold || i.sold_30_days, 0),
    historical_sold: scalar(i.historical_sold, 0),
    rating_star: scalar((i.item_rating || {}).rating_star || i.rating_star, 0),
    rating_count: scalar((i.item_rating || {}).rating_count || i.rating_count, 0),
    models: i.models
  };
}

async function ingestItems(items) {
  const mapped = items.map(mapForRpc).filter((i) => i.itemid);
  if (!mapped.length) return;
  const c = await cfg();

  console.log(`[ShopeeSniper BG] ingest de ${mapped.length} itens`);

  // 1) backend FastAPI (normaliza + empurra pro Supabase via RPC)
  await postBackend({
    route: 'overlay/normalized-items',
    payload: { items: mapped },
    captured_at: Date.now() / 1000
  });

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

// 📌 tracking: upsert/delete na tabela tracked_items (sync entre PCs)
async function syncTrack(item) {
  const c = await cfg();
  if (!c.supabaseUrl || !c.supabaseKey || !item || !item.itemid) return;
  const headers = {
    'apikey': c.supabaseKey,
    'Authorization': `Bearer ${c.supabaseKey}`,
    'Content-Type': 'application/json'
  };
  if (item.tracked) {
    await fetch(`${c.supabaseUrl}/rest/v1/tracked_items`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        item_id: Number(item.itemid),
        shop_id: item.shopid ? Number(item.shopid) : null,
        name: item.name || null,
        updated_at: new Date().toISOString()
      })
    }).then((r) => {
      if (!r.ok) console.log('[ShopeeSniper BG] track upsert → ' + r.status);
    }).catch(() => {});
  } else {
    await fetch(`${c.supabaseUrl}/rest/v1/tracked_items?item_id=eq.${item.itemid}`, {
      method: 'DELETE',
      headers
    }).catch(() => {});
  }
}

async function fetchTracked() {
  const c = await cfg();
  if (!c.supabaseUrl || !c.supabaseKey) return [];
  const r = await fetch(
    `${c.supabaseUrl}/rest/v1/tracked_items?select=item_id,shop_id,name,created_at&order=created_at.desc`,
    { headers: { 'apikey': c.supabaseKey, 'Authorization': `Bearer ${c.supabaseKey}` } }
  );
  if (!r.ok) return [];
  return r.json();
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
  if (!rows.length || rows[0].sales_on_date == null) return null;
  // normaliza por dias decorridos — coleta irregular não pode inflar o 24h
  const days = rows[0].days_since_prev || 1;
  return Math.round(rows[0].sales_on_date / days);
}
