/**
 * ShopeeSniper Pro — content_overlay (ISOLATED world)
 *
 * Recebe os eventos do interceptor via window.postMessage, indexa os itens
 * capturados e injeta a UI analítica (top bar, badges por card, drawer PDP).
 */
(function () {
  'use strict';

  // ======================================================================
  // Estado
  // ======================================================================
  var items = new Map();       // itemid -> item normalizado
  var shops = new Map();       // shopid -> shop
  var ratings = new Map();     // itemid -> [ratings]
  var filters = { rising: false, weak: false };

  // ======================================================================
  // Unit economics (espelha backend unit_economics.py)
  // ======================================================================
  var FEES = { comm: 0.14, fs: 0.06, cap: 100, fixed: 4.0, fixedThr: 8.0,
               tax: 0.06, ads: 0.08 };

  function feeTotal(price) {
    var comm = Math.min(price * FEES.comm, FEES.cap);
    var fixed = price < FEES.fixedThr ? price / 2 : FEES.fixed;
    return comm + price * FEES.fs + fixed + price * FEES.tax + price * FEES.ads;
  }

  function grossAfterShopee(price) { return price - feeTotal(price); }

  function cmvTeto(price, targetMargin) {
    return price - feeTotal(price) - targetMargin * price;
  }

  function brl(v) {
    if (v == null || isNaN(v)) return '—';
    return 'R$ ' + Number(v).toLocaleString('pt-BR',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function n(v) { return (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pt-BR'); }

  // ======================================================================
  // Captura
  // ======================================================================
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== 'SHOPEE_SNIPER_INTERCEPT') return;
    try { handlePayload(d.route, d.payload); } catch (e) {
      console.warn('[ShopeeSniper] erro no payload', e);
    }
  });

  function handlePayload(route, p) {
    var list = extractItems(p);
    list.forEach(function (it) {
      var id = it.itemid || it.item_id;
      if (!id) return;
      var old = items.get(String(id));
      if (!old) {
        items.set(String(id), it);
      } else {
        // merge: campos definidos do novo sobrescrevem o antigo; um
        // payload magro (recommend) nunca apaga o rico (item/get)
        for (var k in it) {
          if (it[k] !== undefined && it[k] !== null) old[k] = it[k];
        }
      }
    });

    if (route.indexOf('get_shop_base') !== -1) {
      var shop = (p && p.data) || p;
      var sid = shop && (shop.shopid || shop.shop_id);
      if (sid) shops.set(String(sid), shop);
    }
    if (route.indexOf('get_ratings') !== -1) {
      var data = (p && p.data) || {};
      if (data.itemid && data.ratings) ratings.set(String(data.itemid), data.ratings);
    }

    schedulePaint();
    // manda pro backend (background script persiste no Supabase)
    safeSend({ type: 'SSP_INGEST', route: route, payload: p });
  }

  function extractItems(p) {
    // deep-scan: qualquer objeto com itemid + (price|name|rating) vira item.
    // Robusto pra shapes diferentes (search_items, recommend/sections, get_pc).
    var out = [];
    var seen = {};
    function push(it) {
      var id = it.itemid || it.item_id;
      if (!id) return;
      // rating/ref com itemid mas poucos campos pode aparecer antes do
      // item completo — troca pela versão mais rica
      if (seen[id]) {
        var idx = out.indexOf(seen[id]);
        if (idx !== -1 && Object.keys(it).length > Object.keys(seen[id]).length) {
          out[idx] = it;
          seen[id] = it;
        }
        return;
      }
      seen[id] = it;
      out.push(it);
    }
    function isItem(n) {
      return n.itemid != null || n.item_id != null;
    }
    function walk(node, depth, budget) {
      if (!node || typeof node !== 'object' || depth > 9 || budget.n > 4000)
        return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, budget);
        return;
      }
      budget.n++;
      if (node.item_basic && typeof node.item_basic === 'object') {
        push(node.item_basic);
        return;
      }
      if (isItem(node)) {
        push(node);
        return; // não desce dentro do item (models têm modelid, não itemid)
      }
      for (var k in node) walk(node[k], depth + 1, budget);
    }
    walk(p, 0, { n: 0 });
    return out;
  }

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); }
    catch (e) {}
  }

  // ======================================================================
  // A) Top Niche Bar (páginas de busca)
  // ======================================================================
  function hasProductGrid() {
    // busca, categoria, oficial: qualquer página com cards de produto
    return document.querySelectorAll('a[href*="-i."], a[href*="/product/"]')
      .length >= 4;
  }

  function refreshTopBar() {
    if (!hasProductGrid() || items.size === 0) return;
    var bar = document.getElementById('ssp-topbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ssp-topbar';
      bar.className = 'ssp-topbar';
      document.body.prepend(bar);
    }

    var arr = Array.from(items.values());
    var vol30 = 0, rev30 = 0, priceSum = 0, priceN = 0, ratSum = 0, ratN = 0;
    arr.forEach(function (it) {
      var s30 = it.sold || it.sold_30_days || 0;
      var price = it.price || it.price_min || 0;
      vol30 += s30;
      rev30 += s30 * price;
      if (price) { priceSum += price; priceN++; }
      var r = it.item_rating && it.item_rating.rating_star;
      if (r) { ratSum += r; ratN++; }
    });

    bar.innerHTML =
      '<span class="ssp-brand">🎯 ShopeeSniper</span>' +
      stat('Vol. 30d', n(vol30)) +
      stat('Receita 30d', brl(rev30)) +
      stat('Ticket médio', brl(priceN ? priceSum / priceN : 0)) +
      stat('Rating médio', ratN ? (ratSum / ratN).toFixed(2) + '★' : '—') +
      '<button id="ssp-rising" class="ssp-btn' + (filters.rising ? ' on' : '') +
        '">🔥 Rising Stars</button>' +
      '<button id="ssp-weak" class="ssp-btn' + (filters.weak ? ' on' : '') +
        '">🎯 Weak Sellers</button>' +
      '<button id="ssp-csv" class="ssp-btn">📥 Export CSV</button>';

    bar.querySelector('#ssp-rising').onclick = function () {
      filters.rising = !filters.rising; refreshTopBar(); decorateVisibleCards();
    };
    bar.querySelector('#ssp-weak').onclick = function () {
      filters.weak = !filters.weak; refreshTopBar(); decorateVisibleCards();
    };
    bar.querySelector('#ssp-csv').onclick = exportCSV;
  }

  function stat(label, value) {
    return '<span class="ssp-stat"><b>' + value + '</b><i>' + label + '</i></span>';
  }

  // ======================================================================
  // B) Badge por card de produto
  // ======================================================================
  function parseIds(href) {
    var m = href && href.match(/-i\.(\d+)\.(\d+)/);
    if (m) return { shopid: m[1], itemid: m[2] };
    m = href && href.match(/\/product\/(\d+)\/(\d+)/);
    return m ? { shopid: m[1], itemid: m[2] } : null;
  }

  function findItemIdInCard(card) {
    var a = card.matches('a[href*="-i."], a[href*="/product/"]')
      ? card
      : card.querySelector('a[href*="-i."], a[href*="/product/"]');
    if (!a) return null;
    return parseIds(a.href);
  }

  function passesFilters(it) {
    var ok = true;
    if (filters.rising) {
      var s30 = it.sold || 0;
      ok = ok && (it.age_days != null && it.age_days < 90 && s30 / 30 > 3);
    }
    if (filters.weak) {
      var rating = (it.item_rating && it.item_rating.rating_star) || 5;
      var sold = it.sold || 0;
      ok = ok && (sold > 100 && (rating < 4.7 || (it.stock != null && it.stock < 10)));
    }
    return ok;
  }

  function decorateVisibleCards() {
    var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
    links.forEach(function (a) {
      var card = a.closest('li, .shopee-search-item-result__item, [data-sqe="item"]') || a;
      var ids = findItemIdInCard(card);
      if (!ids) return;
      var it = items.get(ids.itemid);
      if (!it) return;

      var host = card;
      if (!passesFilters(it)) {
        card.classList.add('ssp-dimmed');
      } else {
        card.classList.remove('ssp-dimmed');
      }
      if (host.querySelector('.ssp-badge')) return;

      var badge = document.createElement('div');
      badge.className = 'ssp-badge';
      badge.innerHTML = badgeHTML(it);
      host.appendChild(badge);

      // delta 24h via backend/Supabase (background)
      safeSend({ type: 'SSP_DELTA', itemid: ids.itemid });
    });
  }

  function badgeHTML(it) {
    var s30 = it.sold || it.sold_30_days || 0;
    var hist = it.historical_sold || 0;
    var price = it.price || it.price_min || 0;
    var age = it.age_days;
    var vel30 = (s30 / 30).toFixed(1);
    var velLife = age ? (hist / Math.max(age, 1)).toFixed(1) : '—';
    var rev30 = s30 * price;
    var gross = grossAfterShopee(price);
    var cmv = cmvTeto(price, 0.20);

    return '' +
      '<div class="ssp-row"><span>📅 ' + (it.created_date || '—') +
        (age != null ? ' (' + age + 'd)' : '') + '</span>' +
      '<span>⚡ ' + vel30 + '/d (30d) vs ' + velLife + '/d</span></div>' +
      '<div class="ssp-row"><span>💰 30d: ' + brl(rev30) + '</span>' +
      '<span>📦 ' + n(it.stock) + ' un.</span></div>' +
      '<div class="ssp-row ssp-profit"><span>🧮 Pós-Shopee: ' + brl(gross) + '</span></div>' +
      '<div class="ssp-row ssp-cmv"><span>🎯 CMV Teto (20%): ' + brl(cmv) + '</span></div>' +
      '<div class="ssp-row ssp-delta" data-itemid="' + it.itemid + '">' +
        '<span>📈 24h: <i>carregando…</i></span></div>';
  }

  // delta respondido pelo background
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'SSP_DELTA_RESULT') {
      var el = document.querySelector('.ssp-delta[data-itemid="' + msg.itemid + '"]');
      if (el) {
        var txt = msg.sales != null ? '+' + msg.sales + ' vendas' : 'sem baseline';
        el.innerHTML = '<span>📈 24h: ' + txt + '</span>';
      }
    }
  });

  // ======================================================================
  // C) PDP Super-Drawer
  // ======================================================================
  function currentPdpItemId() {
    var ids = parseIds(location.href);
    return ids ? ids.itemid : null;
  }

  function maybeRenderDrawer() {
    var itemid = currentPdpItemId();
    if (!itemid) {
      var old = document.getElementById('ssp-drawer');
      if (old) old.remove();
      return;
    }
    var it = items.get(itemid);
    if (!it) return; // espera o payload detalhado (item/get ou pdp/get_pc)

    // só reconstrói se mudou (evita flicker/jank a cada repaint)
    var key = itemid + ':' + ((it.models || []).length) + ':' +
              ((ratings.get(itemid) || []).length);
    var drawer = document.getElementById('ssp-drawer');
    if (drawer && drawer.dataset.key === key) return;

    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'ssp-drawer';
      drawer.className = 'ssp-drawer';
      document.body.appendChild(drawer);
    }
    drawer.dataset.key = key;
    drawer.innerHTML =
      '<div class="ssp-drawer-head">🎯 ShopeeSniper <button id="ssp-toggle">▾</button></div>' +
      '<div class="ssp-drawer-body">' +
        skuTableHTML(it) +
        sellerCardHTML(it) +
        painMinerHTML(itemid) +
        mediaHTML(it) +
      '</div>';
    drawer.querySelector('#ssp-toggle').onclick = function () {
      drawer.classList.toggle('collapsed');
    };
    drawer.querySelectorAll('.ssp-media-dl').forEach(function (b) {
      b.onclick = function () {
        safeSend({ type: 'SSP_DOWNLOAD', url: b.dataset.url,
                   filename: b.dataset.name });
      };
    });
  }

  function skuTableHTML(it) {
    var models = it.models || [];
    if (!models.length) {
      return '<div class="ssp-section"><h4>📦 Variações (SKU)</h4>' +
        '<p>Sem dados de variação neste payload.</p></div>';
    }
    var totalStock = models.reduce(function (s, m) { return s + (m.stock || 0); }, 0) || 1;
    var rows = models.map(function (m) {
      var share = ((m.stock || 0) / totalStock * 100).toFixed(0);
      return '<tr><td>' + (m.name || m.model_name || '—') + '</td>' +
             '<td>' + brl(m.price) + '</td>' +
             '<td>' + n(m.stock) + '</td>' +
             '<td>' + share + '%</td></tr>';
    }).join('');
    return '<div class="ssp-section"><h4>📦 Variações (SKU)</h4>' +
      '<table class="ssp-table"><thead><tr><th>Variação</th><th>Preço</th>' +
      '<th>Estoque</th><th>Share</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>';
  }

  function sellerCardHTML(it) {
    var shop = shops.get(String(it.shopid)) || {};
    return '<div class="ssp-section"><h4>🏪 Vendedor</h4><div class="ssp-grid">' +
      '<span>Rating: <b>' + (shop.rating_star != null ? shop.rating_star.toFixed(2) + '★' : '—') + '</b></span>' +
      '<span>Chat: <b>' + (shop.response_rate != null ? shop.response_rate + '%' : '—') + '</b></span>' +
      '<span>Resp. média: <b>' + (shop.response_time || '—') + '</b></span>' +
      '<span>Seguidores: <b>' + n(shop.follower_count) + '</b></span>' +
      '<span>Local: <b>' + (shop.location || '—') + '</b></span>' +
      '</div></div>';
  }

  var PAIN_KW = {
    'Qualidade': ['rasgou', 'quebrou', 'frágil', 'defeito', 'descosturou'],
    'Tamanho': ['pequeno', 'grande', 'tamanho', 'não serviu'],
    'Entrega': ['atraso', 'demorou', 'embalagem', 'amassado'],
    'Foto': ['diferente', 'foto', 'enganoso']
  };

  function painMinerHTML(itemid) {
    var rs = ratings.get(itemid) || [];
    var neg = rs.filter(function (r) { return (r.rating_star || 5) <= 3; });
    var counts = {};
    neg.forEach(function (r) {
      var c = (r.comment || '').toLowerCase();
      for (var cat in PAIN_KW) {
        if (PAIN_KW[cat].some(function (k) { return c.indexOf(k) !== -1; })) {
          counts[cat] = (counts[cat] || 0) + 1;
        }
      }
    });
    var lines = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (c) { return '<li>' + c + ': <b>' + counts[c] + '×</b></li>'; }).join('');
    return '<div class="ssp-section"><h4>😤 Pain Miner (1–3★)</h4>' +
      '<p>' + neg.length + ' reviews negativas capturadas</p>' +
      '<ul class="ssp-pain">' + (lines || '<li>sem padrões ainda</li>') + '</ul></div>';
  }

  function mediaHTML(it) {
    var imgs = (it.images || []).map(function (h) {
      return { url: 'https://cf.shopee.com.br/file/' + h, name: 'img_' + h + '.jpg' };
    });
    if (it.video_info_list) {
      it.video_info_list.forEach(function (v) {
        var url = v.default_format && v.default_format.url;
        if (url) imgs.push({ url: url, name: 'video_' + (v.vid || 'p') + '.mp4' });
      });
    }
    var btns = imgs.map(function (m) {
      return '<button class="ssp-btn ssp-media-dl" data-url="' + m.url +
             '" data-name="' + m.name + '">⬇ ' + m.name.slice(0, 18) + '</button>';
    }).join('');
    return '<div class="ssp-section"><h4>📸 Mídia (' + imgs.length + ')</h4>' +
      '<div class="ssp-media">' + (btns || '—') + '</div></div>';
  }

  // ======================================================================
  // CSV export
  // ======================================================================
  function exportCSV() {
    var head = 'itemid;shopid;nome;preco;vendidos_30d;historical_sold;estoque;criado;age_days;rating\n';
    var rows = Array.from(items.values()).map(function (it) {
      var rating = (it.item_rating && it.item_rating.rating_star) || '';
      return [it.itemid, it.shopid, '"' + String(it.name || '').replace(/"/g, '""') + '"',
        it.price || it.price_min || '', it.sold || '', it.historical_sold || '',
        it.stock != null ? it.stock : '', it.created_date || '', it.age_days != null ? it.age_days : '',
        rating].join(';');
    }).join('\n');
    var blob = new Blob(['﻿' + head + rows], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shopee_sniper_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ======================================================================
  // Observer + pintura com debounce (a Shopee muda o DOM o tempo todo —
  // sem throttle isso vira 100% CPU)
  // ======================================================================
  var paintTimer = null;
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(function () {
      paintTimer = null;
      refreshTopBar();
      decorateVisibleCards();
      maybeRenderDrawer();
    }, 400);
  }

  var mo = new MutationObserver(schedulePaint);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // SPA da Shopee troca de página sem reload
  setInterval(schedulePaint, 3000);

  schedulePaint();
})();
