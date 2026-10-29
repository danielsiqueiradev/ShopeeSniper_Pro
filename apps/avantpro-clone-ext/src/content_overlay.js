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
  var filters = { rising: false, weak: false, opp: false };

  // cortes do filtro 💎 — editáveis no painel ⚙️ da top bar,
  // persistidos em localStorage.ssp_opp_cfg
  var OPP_DEFAULT = { minSold: 30, maxSold: 999999,
                      minPrice: 15, maxPrice: 300, rating: 4.7 };
  function loadOpp() {
    var out = {};
    try {
      var c = JSON.parse(localStorage.getItem('ssp_opp_cfg') || '{}');
      for (var k in OPP_DEFAULT) {
        out[k] = (typeof c[k] === 'number') ? c[k] : OPP_DEFAULT[k];
      }
    } catch (e) {
      for (var k2 in OPP_DEFAULT) out[k2] = OPP_DEFAULT[k2];
    }
    return out;
  }
  var OPP = loadOpp();

  // itens marcados pra acompanhamento diário (revisitar PDP → série
  // temporal de snapshots no Supabase). Persiste em localStorage.
  var tracked = loadTracked();
  function loadTracked() {
    try { return JSON.parse(localStorage.getItem('ssp_tracked') || '{}'); }
    catch (e) { return {}; }
  }
  function saveTracked() {
    try { localStorage.setItem('ssp_tracked', JSON.stringify(tracked)); }
    catch (e) {}
  }
  function isTracked(id) { return !!tracked[String(id)]; }

  // liga/desliga global do tracker — pausa a criação de novos 📌 sem
  // perder a lista existente. Persiste em localStorage.
  var trackerOn = (function () {
    try { return localStorage.getItem('ssp_tracker_on') !== '0'; }
    catch (e) { return true; }
  })();
  function setTrackerOn(v) {
    trackerOn = v;
    try {
      if (v) localStorage.removeItem('ssp_tracker_on');
      else localStorage.setItem('ssp_tracker_on', '0');
    } catch (e) {}
  }
  function toggleTrack(it) {
    var id = String(it.itemid || it.item_id);
    if (!trackerOn && !tracked[id]) return; // tracker pausado: só permite remover
    if (tracked[id]) delete tracked[id];
    else tracked[id] = { name: it.name || '', shopid: it.shopid,
                         at: Date.now() };
    saveTracked();
    updatePins();
    refreshTopBar();
    pushTrack(id, !!tracked[id], it);
  }

  // sync com Supabase: localStorage é cache, o banco é a fonte de
  // verdade entre PCs
  function pushTrack(id, on, it) {
    it = it || tracked[id] || {};
    try {
      chrome.runtime.sendMessage({
        type: 'SSP_TRACK',
        item: { itemid: id, shopid: it.shopid, name: it.name, tracked: on }
      }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }
  // 📌 nos badges dos itens trackados
  function updatePins() {
    document.querySelectorAll('.ssp-badge').forEach(function (b) {
      var pin = b.querySelector('.ssp-pin');
      if (isTracked(b.dataset.itemid)) {
        if (!pin) {
          pin = document.createElement('span');
          pin.className = 'ssp-pin';
          pin.textContent = '📌';
          b.prepend(pin);
        }
      } else if (pin) pin.remove();
    });
  }

  // ======================================================================
  // Unit economics — configurável no ⚙️ (localStorage.ssp_fees_cfg).
  // Defaults são estimativas genéricas; o usuário calibra com as taxas
  // reais da própria conta de vendedor.
  // ======================================================================
  var FEE_DEFAULT = { comm: 14, fs: 6, cap: 100, fixed: 4.0,
                      fixedThr: 8.0, tax: 0, ads: 0, margin: 20 };
  function loadFees() {
    var out = {};
    try {
      var c = JSON.parse(localStorage.getItem('ssp_fees_cfg') || '{}');
      for (var k in FEE_DEFAULT) {
        out[k] = (typeof c[k] === 'number') ? c[k] : FEE_DEFAULT[k];
      }
    } catch (e) {
      for (var k2 in FEE_DEFAULT) out[k2] = FEE_DEFAULT[k2];
    }
    return out;
  }
  var FEES = loadFees();

  function feeBreakdown(price) {
    return {
      comm: Math.min(price * FEES.comm / 100, FEES.cap),
      fixed: price < FEES.fixedThr ? price / 2 : FEES.fixed,
      fs: price * FEES.fs / 100,
      tax: price * FEES.tax / 100,
      ads: price * FEES.ads / 100
    };
  }

  function feeTotal(price) {
    var f = feeBreakdown(price);
    return f.comm + f.fixed + f.fs + f.tax + f.ads;
  }

  function grossAfterShopee(price) { return price - feeTotal(price); }

  function cmvTeto(price, targetMargin) {
    var m = (targetMargin != null ? targetMargin : FEES.margin) / 100;
    return price - feeTotal(price) - m * price;
  }

  // normaliza campos ×100000 vindos de payload não-interceptado (SSR/JSON)
  var SSP_PRICE_KEYS = {
    price: 1, price_min: 1, price_max: 1,
    price_before_discount: 1, raw_price: 1
  };
  function normItem(it) {
    for (var k in SSP_PRICE_KEYS) {
      if (typeof it[k] === 'number' && it[k] > 100000) {
        it[k] = it[k] / 100000;
      }
    }
    if (it.ctime && !it.created_date) {
      var d = new Date(it.ctime * 1000);
      it.created_date = ('0' + d.getDate()).slice(-2) + '/' +
        ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
      it.age_days = Math.max(0,
        Math.floor((Date.now() / 1000 - it.ctime) / 86400));
    }
    return it;
  }

  function brl(v) {
    if (v == null || isNaN(v)) return '—';
    return 'R$ ' + Number(v).toLocaleString('pt-BR',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function n(v) { return (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pt-BR'); }

  // "mesmo produto" entre lojas, em duas camadas:
  //  1) mesma imagem principal (hash da foto ~ identificador do produto)
  //  2) título com word-set parecido (Jaccard >= 0.5 — ordem não importa)
  var NAME_STOP = { de: 1, da: 1, do: 1, com: 1, para: 1, pra: 1, e: 1,
                    em: 1, a: 1, o: 1, un: 1, c: 1 };

  function nameTokens(name) {
    if (!name) return {};
    var t = String(name).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ');
    var out = {};
    for (var i = 0; i < t.length; i++) {
      if (t[i] && !NAME_STOP[t[i]]) out[t[i]] = 1;
    }
    return out;
  }

  function jaccard(a, b) {
    var inter = 0, union = 0;
    for (var k in a) { union++; if (b[k]) inter++; }
    for (var k2 in b) { if (!a[k2]) union++; }
    return union ? inter / union : 0;
  }

  // union-find sobre arr: funde itens com mesma imagem ou nome parecido;
  // retorna quantos itens vivem em cluster com >1 membro ("repetidos")
  function countRepeated(arr) {
    var parent = arr.map(function (_, i) { return i; });
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function uni(a, b) { parent[find(a)] = find(b); }

    var byImg = {};
    arr.forEach(function (it, i) {
      var img = it.image || (it.images && it.images[0]);
      if (!img) return;
      if (byImg[img] != null) uni(i, byImg[img]);
      else byImg[img] = i;
    });

    var toks = arr.map(function (it) { return nameTokens(it.name); });
    for (var i = 0; i < toks.length; i++) {
      for (var j = i + 1; j < toks.length; j++) {
        if (jaccard(toks[i], toks[j]) >= 0.5) uni(i, j);
      }
    }

    var sizes = {};
    for (var x = 0; x < arr.length; x++) {
      var r = find(x);
      sizes[r] = (sizes[r] || 0) + 1;
    }
    var rep = 0;
    for (var c in sizes) { if (sizes[c] > 1) rep += sizes[c]; }
    return rep;
  }

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
      normItem(it);
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
      var merged = items.get(String(id));
      // nome chegou agora e o item tá 📌 → propaga pro painel e pro
      // Supabase (itens trackados sem nome ficavam "item 58269...")
      if (merged.name && tracked[String(id)] &&
          tracked[String(id)].name !== merged.name) {
        tracked[String(id)].name = merged.name;
        saveTracked();
        pushTrack(String(id), true, merged);
      }
      queueItem(merged);
    });

    // shop/ratings podem vir embutidos em qualquer payload (pdp/get_pc
    // carrega tudo junto; rotas migram de v4→v2) — varre o JSON em vez
    // de depender do nome da rota
    var shop = findShop(p);
    if (shop) {
      var sid = shop.shopid || shop.shop_id;
      if (sid) shops.set(String(sid), shop);
    }

    findRatings(p).forEach(function (rlist) {
      var rId = (rlist[0] && rlist[0].itemid) || currentPdpItemId();
      if (!rId) return;
      var key = String(rId);
      var cur = ratings.get(key) || [];
      var seen = {};
      cur.concat(rlist).forEach(function (r) {
        var rk = r.rkey || (r.userid + ':' + (r.ctime || 0));
        if (!seen[rk]) { seen[rk] = 1; cur.push(r); }
      });
      ratings.set(key, cur);
    });

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

  // arrays de reviews: elementos com rating_star + (comment|rkey|userid)
  function findRatings(p) {
    var out = [];
    function isRating(x) {
      return x && typeof x === 'object' && x.rating_star != null &&
             (x.comment != null || x.rkey != null || x.userid != null);
    }
    function walk(node, depth, budget) {
      if (!node || typeof node !== 'object' || depth > 9 || budget.n > 4000)
        return;
      if (Array.isArray(node)) {
        if (node.length && isRating(node[0])) out.push(node);
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, budget);
        return;
      }
      budget.n++;
      for (var k in node) walk(node[k], depth + 1, budget);
    }
    walk(p, 0, { n: 0 });
    return out;
  }

  // objeto de loja: tem shopid + métricas de vendedor (rating/followers/chat)
  function findShop(p) {
    var found = null;
    function isShop(x) {
      return x && typeof x === 'object' &&
             (x.shopid != null || x.shop_id != null) &&
             (x.follower_count != null || x.response_rate != null ||
              (x.rating_star != null && x.itemid == null));
    }
    function walk(node, depth, budget) {
      if (found || !node || typeof node !== 'object' ||
          depth > 8 || budget.n > 3000) return;
      budget.n++;
      if (!Array.isArray(node) && isShop(node)) { found = node; return; }
      for (var k in node) {
        if (found) return;
        walk(node[k], depth + 1, budget);
      }
    }
    walk(p, 0, { n: 0 });
    return found;
  }

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); }
    catch (e) {}
  }

  // fila de itens normalizados pra ingest (backend + Supabase via background).
  // flush a cada 5s — dá tempo do merge/DOM enriquecer antes de enviar.
  // Fingerprint: só re-envia se algum campo útil mudou — evita spam de
  // RPC a cada paint e impede dados antigos regravarem o banco.
  var ingestQueue = new Map();
  var sentFp = {};
  function queueItem(it) {
    var id = it.itemid || it.item_id;
    if (!id) return;
    var fp = [it.name, it.price, it.sold, it.sold_30_days,
              it.historical_sold, it.stock, it.ctime,
              (it.item_rating || {}).rating_star].join('|');
    if (sentFp[String(id)] === fp) return;
    it.__fp = fp;
    ingestQueue.set(String(id), it);
  }
  setInterval(function () {
    if (!ingestQueue.size) return;
    var list = Array.from(ingestQueue.values());
    ingestQueue.clear();
    list.forEach(function (it) {
      sentFp[String(it.itemid || it.item_id)] = it.__fp;
    });
    safeSend({ type: 'SSP_INGEST_ITEMS', items: list });
  }, 5000);

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

    // stats só do grid atual: o mapa items acumula a sessão toda —
    // agregar tudo inflava receita/ticket com itens de outras buscas
    var pageIds = {};
    document.querySelectorAll('a[href*="-i."], a[href*="/product/"]')
      .forEach(function (a) {
        var ids = parseIds(a.href);
        if (ids) pageIds[ids.itemid] = 1;
      });
    var arr = [];
    for (var pid in pageIds) {
      var pit = items.get(pid);
      if (pit) arr.push(pit);
    }
    var scoped = arr.length > 0;
    if (!scoped) arr = Array.from(items.values()); // SSR/denso: fallback

    var vol30 = 0, rev30 = 0, priceSum = 0, priceN = 0, ratSum = 0, ratN = 0;
    var shopsSeen = {};
    var pMin = null, pMax = null;
    arr.forEach(function (it) {
      var s30 = it.sold || it.sold_30_days || 0;
      var price = it.price || it.price_min || 0;
      vol30 += s30;
      rev30 += s30 * price;
      if (price) {
        priceSum += price; priceN++;
        if (pMin == null || price < pMin) pMin = price;
        if (pMax == null || price > pMax) pMax = price;
      }
      var r = it.item_rating && it.item_rating.rating_star;
      if (r) { ratSum += r; ratN++; }
      if (it.shopid) shopsSeen[it.shopid] = 1;
    });

    // mesmo produto vendido por lojas diferentes = demanda validada;
    // concentração alta (1 produto domina) = nicho maduro/commodity
    var rep = countRepeated(arr);
    var nSellers = Object.keys(shopsSeen).length;

    bar.innerHTML =
      '<span class="ssp-brand">🎯 ShopeeSniper</span>' +
      stat('Itens', arr.length + (scoped ? '' : '*')) +
      stat('Vendedores', nSellers || '—') +
      stat('Repetidos', rep + '/' + arr.length) +
      stat('Vol. 30d', n(vol30)) +
      stat('Receita 30d', brl(rev30)) +
      stat('Faixa', pMin != null ? brl(pMin) + '–' + brl(pMax) : '—') +
      stat('Ticket médio', brl(priceN ? priceSum / priceN : 0)) +
      stat('Rating médio', ratN ? (ratSum / ratN).toFixed(2) + '★' : '—') +
      '<button id="ssp-rising" class="ssp-btn' + (filters.rising ? ' on' : '') +
        '">🔥 Rising Stars</button>' +
      '<button id="ssp-weak" class="ssp-btn' + (filters.weak ? ' on' : '') +
        '">🎯 Weak Sellers</button>' +
      '<button id="ssp-opp" class="ssp-btn' + (filters.opp ? ' on' : '') +
        '">💎 Oportunidade</button>' +
      '<button id="ssp-enrich" class="ssp-btn" title="Rola a página pra forçar o carregamento lazy (reviews, mais itens) — 100% passivo">🔎 Varrer</button>' +
      '<button id="ssp-tracked" class="ssp-btn" title="Itens marcados pra acompanhamento diário">📌 ' +
        Object.keys(tracked).length + (trackerOn ? '' : ' ⏸') + '</button>' +
      '<button id="ssp-cfg" class="ssp-btn">⚙️</button>' +
      '<button id="ssp-csv" class="ssp-btn">📥 Export CSV</button>';

    bar.querySelector('#ssp-rising').onclick = function () {
      filters.rising = !filters.rising; refreshTopBar(); decorateVisibleCards();
    };
    bar.querySelector('#ssp-weak').onclick = function () {
      filters.weak = !filters.weak; refreshTopBar(); decorateVisibleCards();
    };
    bar.querySelector('#ssp-opp').onclick = function () {
      filters.opp = !filters.opp; refreshTopBar(); decorateVisibleCards();
    };
    // painel de config fica FORA da bar: refreshTopBar refaz o innerHTML
    // a cada payload novo, o que apagava o input enquanto o usuário digita
    // 🔎 Varrer: rola até o fim da página em passos — as seções lazy
    // (reviews, recomendados, próximos itens) disparam as próprias
    // chamadas de API, que o interceptor lê passivamente. Zero fetch
    // extra = indetectável (fetch manual era flagrado: requests da
    // Shopee são assinados, um fetch nosso não carrega a assinatura)
    bar.querySelector('#ssp-enrich').onclick = function () {
      var steps = 10, i = 0;
      var timer = setInterval(function () {
        i++;
        var h = document.documentElement.scrollHeight;
        window.scrollTo({ top: h * i / steps, behavior: 'smooth' });
        if (i >= steps) {
          clearInterval(timer);
          // a página terminou de carregar os dados lazy — hora de
          // julgar os cards e trackar as oportunidades 💎
          setTimeout(function () {
            var nFound = autoTrackOpportunities();
            var tb = bar.querySelector('#ssp-enrich');
            if (tb && nFound) tb.textContent = '🔎 +' + nFound + ' 📌';
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }, 1500);
        }
      }, 900);
    };
    // painel 📌: lista os trackados com link direto pra PDP — o fluxo
    // diário é abrir cada link (a página carrega get_pc sozinha) pra
    // gravar o snapshot do dia e construir o comparativo
    bar.querySelector('#ssp-tracked').onclick = function () {
      var p = document.getElementById('ssp-trkpanel');
      if (p) { p.remove(); return; }
      p = document.createElement('div');
      p.id = 'ssp-trkpanel';
      p.className = 'ssp-cfg ssp-trkpanel';
      renderTrackedPanel(p);
      var anchor = document.getElementById('ssp-cfgpanel') || bar;
      anchor.insertAdjacentElement('afterend', p);
      // puxa stats do Supabase pra ordenar por volume — chega via
      // SSP_TRACK_STATS_RESULT e re-renderiza a lista
      safeSend({ type: 'SSP_TRACK_STATS',
                 itemids: Object.keys(tracked) });
    };
    bar.querySelector('#ssp-cfg').onclick = function () {
      var p = document.getElementById('ssp-cfgpanel');
      if (p) { p.remove(); return; }
      p = document.createElement('div');
      p.id = 'ssp-cfgpanel';
      p.className = 'ssp-cfg';
      p.innerHTML = cfgRowHTML();
      bar.insertAdjacentElement('afterend', p);
      p.querySelector('#ssp-cfg-save').onclick = function () {
        p.querySelectorAll('input[type="number"]').forEach(function (inp) {
          var v = parseFloat(inp.value);
          if (isNaN(v)) return;
          if (inp.dataset.k) OPP[inp.dataset.k] = v;
          else if (inp.dataset.f) FEES[inp.dataset.f] = v;
        });
        try {
          localStorage.setItem('ssp_opp_cfg', JSON.stringify(OPP));
          localStorage.setItem('ssp_fees_cfg', JSON.stringify(FEES));
        } catch (e) {}
        decorateVisibleCards();
        maybeRenderDrawer();
      };
    };
    bar.querySelector('#ssp-csv').onclick = exportCSV;
  }

  function stat(label, value) {
    return '<span class="ssp-stat"><b>' + value + '</b><i>' + label + '</i></span>';
  }

  // stats do último snapshot por item (via Supabase, quando o painel
  // 📌 abre) — ordena a lista por volume pra ritual diário ser viável
  var trkStats = {};

  function renderTrackedPanel(p) {
    var ids = Object.keys(tracked);
    // mais vendidos no topo; sem stats vai pro fim
    var order = ids.slice().sort(function (a, b) {
      var sa = trkStats[a] &&
               (trkStats[a].sold_30_days || trkStats[a].historical_sold);
      var sb = trkStats[b] &&
               (trkStats[b].sold_30_days || trkStats[b].historical_sold);
      return (sb || -1) - (sa || -1);
    });
    var urls = order.map(function (id) {
      return 'https://shopee.com.br/product/' + (tracked[id].shopid || '0') +
             '/' + id;
    });
    p.innerHTML = ids.length
      ? '<div class="ssp-trk-head">' +
        '<button id="ssp-trk-toggle" class="ssp-btn"' +
        ' title="liga/desliga a criação de novos 📌 (a lista continua)">' +
          (trackerOn ? '⏸ Tracker' : '▶ Tracker') + '</button>' +
        '<button id="ssp-trk-prune" class="ssp-btn"' +
        ' title="remove itens sem dados no banco ou com sinal MONITOR">' +
          '🧹 Limpar fracos</button>' +
        '<button id="ssp-open-top" class="ssp-btn"' +
        ' title="abre as PDPs dos 10 mais vendidos em abas de fundo">' +
        '🔁 Top 10</button>' +
        '<button id="ssp-open-all" class="ssp-btn"' +
        ' title="abre todas em abas de fundo (máx 20)">Todos (' +
          order.length + ')</button></div>' +
        '<div class="ssp-trk-list">' +
        order.map(function (id, i) {
          var t = tracked[id];
          var st = trkStats[id];
          var meta = st
            ? '<span class="ssp-trk-meta">' +
              (st.sold_30_days || st.historical_sold || 0) +
              (st.sold_30_days ? '/30d' : ' total') + ' · ' + brl(st.price) +
              (st.rating_star ? ' · ' + Number(st.rating_star).toFixed(1) + '★' : '') +
              '</span>'
            : '';
          return '<div class="ssp-trk-row">' +
            '<a href="' + urls[i] + '" target="_blank" rel="noopener">' +
              (t.name || 'item ' + id) + '</a>' + meta +
            '<button class="ssp-trk-x" data-id="' + id +
              '" title="parar de acompanhar">✕</button></div>';
        }).join('') + '</div>'
      : '<i>Nenhum item trackado — abra uma PDP e clique 📌 Track no drawer</i>';
    var tog = p.querySelector('#ssp-trk-toggle');
    if (tog) {
      tog.onclick = function () {
        setTrackerOn(!trackerOn);
        refreshTopBar();
        renderTrackedPanel(p);
      };
    }
    var prune = p.querySelector('#ssp-trk-prune');
    if (prune) {
      prune.onclick = function () {
        prune.textContent = '🧹 analisando…';
        // background consulta vw_breach_opportunities pros ids trackados
        // → SSP_TRACK_SCORES_RESULT dispara a limpeza em si
        safeSend({ type: 'SSP_TRACK_SCORES',
                   itemids: Object.keys(tracked) });
      };
    }
    var openTop = p.querySelector('#ssp-open-top');
    if (openTop) {
      openTop.onclick = function () {
        safeSend({ type: 'SSP_OPEN_TABS', urls: urls.slice(0, 10) });
        openTop.textContent = '🔁 abrindo 10…';
      };
    }
    var openAll = p.querySelector('#ssp-open-all');
    if (openAll) {
      openAll.onclick = function () {
        safeSend({ type: 'SSP_OPEN_TABS', urls: urls });
        openAll.textContent = '🔁 abrindo ' + urls.length + '…';
      };
    }
    p.querySelectorAll('.ssp-trk-x').forEach(function (x) {
      x.onclick = function () {
        var xid = x.dataset.id;
        delete tracked[xid];
        saveTracked(); updatePins(); refreshTopBar();
        pushTrack(xid, false, {});
        renderTrackedPanel(p);
      };
    });
  }

  function cfgRowHTML() {
    function inp(k, step) {
      return '<input type="number" data-k="' + k + '" value="' + OPP[k] +
             '"' + (step ? ' step="' + step + '"' : '') + '>';
    }
    function fee(k, step) {
      return '<input type="number" data-f="' + k + '" value="' + FEES[k] +
             '"' + (step ? ' step="' + step + '"' : '') + '>';
    }
    return '<b>💎 Cortes:</b>' +
      'Vendas/mês ' + inp('minSold') + '–' + inp('maxSold') +
      'Preço R$ ' + inp('minPrice') + '–' + inp('maxPrice') +
      'Rating &lt; ' + inp('rating', '0.1') +
      ' <b>🧮 Taxas:</b>' +
      'Comissão ' + fee('comm') + '%' +
      'Frete grátis ' + fee('fs') + '%' +
      'Fixa R$' + fee('fixed', '0.5') +
      'Imposto ' + fee('tax') + '%' +
      'Ads ' + fee('ads') + '%' +
      'Margem ' + fee('margin') + '%' +
      '<button id="ssp-cfg-save" class="ssp-btn on">Salvar</button>';
  }

  // ======================================================================
  // SSR harvest: Shopee embarca os itens como JSON dentro de <script>
  // (páginas com renderização server-side). Raspar isso cobre TODOS os
  // cards sem depender de chamada de API.
  // ======================================================================
  function harvestEmbeddedData() {
    var scripts = document.querySelectorAll('script');
    var found = 0;
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent;
      if (!t || t.length < 100 || t.indexOf('itemid') === -1) continue;
      var j = t.indexOf('{');
      var k = t.lastIndexOf('}');
      if (j === -1 || k <= j) continue;
      try {
        var data = JSON.parse(t.slice(j, k + 1));
        extractItems(data).forEach(function (it) {
          var id = it.itemid || it.item_id;
          if (!id) return;
          normItem(it);
          if (!items.has(String(id))) items.set(String(id), it);
          queueItem(items.get(String(id)));
          found++;
        });
      } catch (e) { /* script não é JSON puro — pula */ }
    }
    if (found) console.log('[ShopeeSniper] SSR: ' + found + ' itens do HTML');
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

  function findLinkInCard(card) {
    return card.matches('a[href*="-i."], a[href*="/product/"]')
      ? card
      : card.querySelector('a[href*="-i."], a[href*="/product/"]');
  }

  // o slug do link carrega o nome do produto: /Boneca-Fada-i.1.2 →
  // "Boneca Fada". Fallback quando o card não renderiza texto útil.
  function nameFromUrl(href) {
    var m = href && href.match(/shopee\.com\.br\/([^/]+)-i\.\d+/);
    if (!m) return '';
    var slug = decodeURIComponent(m[1]).replace(/-/g, ' ').trim();
    return slug.length > 4 ? slug.slice(0, 200) : '';
  }

  // vendedor internacional: frete longo = fraqueza explorável por local.
  // Fontes: shop_location/flags do payload + faixa "VENDEDOR
  // INTERNACIONAL" lida do card no DOM (decorateVisibleCards seta intl_dom)
  function isIntl(it) {
    if (it.intl_dom === true) return true;
    var loc = String(it.shop_location || it.shop_loc || '').toLowerCase();
    return loc.indexOf('overseas') !== -1 ||
           loc.indexOf('internac') !== -1 ||
           loc.indexOf('exterior') !== -1 ||
           it.is_cb === true || it.cb_option === true || it.cb === true;
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
      ok = ok && (sold > 100 && (rating < 4.7 ||
                  (it.stock != null && it.stock < 10) || isIntl(it)));
    }
    // 💎 Oportunidade = a tese de entrada: demanda provada + pelo
    // menos UMA fraqueza explorável do concorrente (mesmos sinais do
    // ⚔️ Plano de Entrada). Sem fraqueza não é brecha — é espelar.
    if (filters.opp) {
      ok = ok && isOppCandidate(it);
    }
    return ok;
  }

  // varre os cards da página e marca 📌 Track nos que passam no
  // filtro 💎 — o 🔎 Varrer termina a rolagem chamando isso, então
  // o usuário sai com a lista de candidatos já persistida no Supabase.
  // Cap de 15/varrida pra não inflar a lista com lixo em nicho grande.
  function autoTrackOpportunities() {
    var added = 0;
    var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
    links.forEach(function (a) {
      if (added >= 15) return;
      var ids = parseIds(a.href);
      if (!ids || isTracked(ids.itemid)) return;
      var it = items.get(ids.itemid);
      if (!it || !isOppCandidate(it)) return;
      tracked[ids.itemid] = { name: it.name || nameFromUrl(a.href) || '',
                              shopid: it.shopid, at: Date.now() };
      pushTrack(ids.itemid, true, it);
      added++;
    });
    if (added) {
      saveTracked(); updatePins(); refreshTopBar();
      console.log('[ShopeeSniper] auto-track: ' + added + ' oportunidades 📌');
    }
    return added;
  }

  // o mesmo critério do filtro 💎 — reaproveitado pelo auto-track
  // do 🔎 Varrer e pelo passesFilters
  function isOppCandidate(it) {
    var s = it.sold || it.sold_30_days || 0;
    var pr = it.price || it.price_min || 0;
    if (!(s >= OPP.minSold && s <= OPP.maxSold &&
          pr >= OPP.minPrice && pr <= OPP.maxPrice)) return false;
    var wk = entryWeakness(it);
    return (wk.fortes + wk.meds) > 0;
  }

  // fraquezas exploráveis visíveis no card/listing (shop só quando o
  // payload capturou — PDP enche, busca raramente)
  function entryWeakness(it) {
    var shop = shops.get(String(it.shopid)) || {};
    var rating = (it.item_rating || {}).rating_star;
    var rc = (it.item_rating || {}).rating_count;
    if (Array.isArray(rc)) rc = rc[0];
    var w = { fortes: 0, meds: 0 };
    if (rating != null && rating < 4.4) w.fortes++;
    else if (rating != null && rating < 4.6) w.meds++;
    else if (rating != null && rating >= 4.7 && rc != null &&
             rc > 0 && rc < 15) w.meds++;
    if (shop.response_rate != null && shop.response_rate < 45) w.fortes++;
    else if (shop.response_rate != null && shop.response_rate < 70) w.meds++;
    if (shop.rating_star != null && shop.rating_star < 4.7) w.meds++;
    if (isIntl(it)) w.meds++;
    if (it.stock != null && it.stock < 10) w.meds++;
    // anúncio novo vendendo = demanda quente não consolidada (brecha
    // de timing — o líder ainda não travou o ranking do nicho)
    var age = it.age_days, sold = it.sold || it.sold_30_days || 0;
    if (age != null && age <= 60 && sold >= 300) w.fortes++;
    return w;
  }

  // chips de brecha exibidos no badge — onde dá pra ganhar do líder
  function breachChips(it) {
    var chips = [];
    var rat = it.item_rating && it.item_rating.rating_star;
    if (rat != null && rat < OPP.rating) chips.push('⭐ ' + rat.toFixed(1));
    if (isIntl(it)) chips.push('🌎 intl');
    if (it.stock != null && it.stock < 10) chips.push('📦 ' + it.stock + ' un.');
    var sold = it.sold || it.sold_30_days || 0;
    if (sold >= OPP.minSold && chips.length) chips.unshift('⚔️ entra');
    return chips;
  }

  function decorateVisibleCards() {
    var links = document.querySelectorAll('a[href*="-i."], a[href*="/product/"]');
    links.forEach(function (a) {
      var card = a.closest('li, .shopee-search-item-result__item, [data-sqe="item"]') || a;
      var ids = findItemIdInCard(card);
      if (!ids) return;
      var it = items.get(ids.itemid);
      var fb = domStats(card);
      if (!it) {
        // item só existe no DOM (nenhum payload cobriu) — cria stub
        // com o que o card mostra pra badge/topbar/ingest funcionarem
        if (!fb.price && !fb.sold) return;
        // pula linhas de preço/vendas/badge — o nome é a 1ª linha de
        // texto "normal" do card (alguns layouts trazem R$ antes)
        var lines = (card.innerText || '').split('\n')
          .map(function (s) { return s.trim(); })
          .filter(function (s) {
            return s && !/^R\$/.test(s) && !/Vendido/i.test(s) &&
                   !/un\.$/.test(s) && !/^-?\d+%/.test(s) &&
                   !/com cupom|Frete|Indicado|OFF$/i.test(s) &&
                   !/^[📅⚡💰📦🧮🎯📈🚩⭐]/.test(s);
          });
        var cardLink = findLinkInCard(card);
        it = { itemid: ids.itemid, shopid: ids.shopid,
               name: (lines[0] || '').slice(0, 200) ||
                     nameFromUrl(cardLink && cardLink.href) || null };
        items.set(ids.itemid, it);
        // stub resolveu o nome e o item tá 📌 → propaga pro painel/Supabase
        if (it.name && tracked[ids.itemid] &&
            tracked[ids.itemid].name !== it.name) {
          tracked[ids.itemid].name = it.name;
          saveTracked();
          pushTrack(ids.itemid, true, it);
        }
      }
      // faixa "VENDEDOR INTERNACIONAL" do próprio card — sinal de brecha
      // mesmo quando o payload não traz shop_location
      if (/internacional/i.test(card.innerText || '')) it.intl_dom = true;
      // item conhecido mas sem nome → o slug do card resolve
      if (!it.name) {
        var a2 = findLinkInCard(card);
        var nm = nameFromUrl(a2 && a2.href);
        if (nm) {
          it.name = nm;
          if (tracked[ids.itemid] && tracked[ids.itemid].name !== nm) {
            tracked[ids.itemid].name = nm;
            saveTracked();
            pushTrack(ids.itemid, true, it);
          }
        }
      }
      // grava fallback de volta no map — a top bar agrega daqui
      if (!it.price && !it.price_min) it.price = fb.price;
      if (!it.sold && !it.sold_30_days) it.sold = fb.sold;
      // estrela do card alimenta o filtro 💎 e o badge nos stubs
      if (!it.item_rating && fb.star) {
        it.item_rating = { rating_star: fb.star };
      }
      queueItem(it);

      if (!passesFilters(it)) {
        card.classList.add('ssp-dimmed');
      } else {
        card.classList.remove('ssp-dimmed');
      }
      if (card.querySelector('.ssp-badge')) return;

      // ancora na coluna de info do card (nome/preço/vendidos) — assim o
      // badge empilha embaixo do texto tanto em grid quanto em lista
      var anchor = card.matches('a') ? card
                 : card.querySelector('a[href*="-i."], a[href*="/product/"]');
      var host = (anchor && anchor.querySelector('.p-2.flex-1'))
              || (anchor && anchor.querySelector('[class*="flex-col"]'))
              || card;

      var badge = document.createElement('div');
      badge.className = 'ssp-badge';
      badge.dataset.itemid = ids.itemid;
      badge.innerHTML = badgeHTML(it, fb);
      if (isTracked(ids.itemid)) {
        var pin = document.createElement('span');
        pin.className = 'ssp-pin';
        pin.textContent = '📌';
        badge.prepend(pin);
      }
      host.appendChild(badge);

      // delta 24h via backend/Supabase (background)
      safeSend({ type: 'SSP_DELTA', itemid: ids.itemid });
      // se a resposta não voltar (SW morto, supabase fora), não fica
      // pendurado no "carregando…" pra sempre
      setTimeout(function () {
        var d = badge.querySelector('.ssp-delta');
        if (d && d.innerText.indexOf('carregando') !== -1) {
          d.innerHTML = '<span>📈 24h: —</span>';
        }
      }, 12000);
    });
  }

  // Raspa preço, vendidos e rating do texto do card — fallback quando
  // o item não foi capturado via API/SSR
  function domStats(card) {
    var t = card.innerText || '';
    var price = 0, sold = 0, star = 0;
    var pm = t.match(/R\$\s*([\d.]+,\d{2})/);
    if (pm) price = parseFloat(pm[1].replace(/\./g, '').replace(',', '.'));
    var sm = t.match(/(\d+(?:[.,]\d+)?)\s*(mil)?\+?\s*Vendido/i);
    if (sm) {
      sold = Math.round(parseFloat(sm[1].replace(',', '.')) *
                        (sm[2] ? 1000 : 1));
    }
    // rating aparece como decimal 1.0–5.0 solto numa linha própria
    // (ex.: "4.9" logo acima de "99 Vendido(s)")
    var rm = t.match(/(?:^|\n|\s)([1-5][.,]\d)\s*(?=\n|$)/);
    if (rm) star = parseFloat(rm[1].replace(',', '.'));
    return { price: price, sold: sold, star: star };
  }

  function badgeHTML(it, fb) {
    fb = fb || { price: 0, sold: 0 };
    var s30 = it.sold || it.sold_30_days || fb.sold || 0;
    var hist = it.historical_sold || 0;
    var price = it.price || it.price_min || fb.price || 0;
    var age = it.age_days;
    // janela real do sold_30_days: anúncio de 5 dias vendeu os 30d dele
    // em 5 dias, não 30 — dividir por 30 subestimava a velocidade
    var win = age != null ? Math.min(30, Math.max(age, 1)) : 30;
    var vel30 = (s30 / win).toFixed(1);
    var velLbl = win < 30 ? '/d (' + win + 'd)' : '/d (30d)';
    var velLife = age ? (hist / Math.max(age, 1)).toFixed(1) : '—';
    var rev30 = s30 * price;
    var gross = grossAfterShopee(price);
    var cmv = cmvTeto(price);
    // rating do produto (estrelas + nº de avaliações)
    var rstar = (it.item_rating && it.item_rating.rating_star) || fb.star;
    var rcount = it.item_rating && it.item_rating.rating_count;
    if (Array.isArray(rcount)) rcount = rcount[0];
    var starTxt = rstar != null ? Number(rstar).toFixed(1) : '—';

    var chips = breachChips(it);
    var breachRow = chips.length
      ? '<div class="ssp-row ssp-breach"><span>🚩 ' + chips.join(' · ') +
        '</span></div>'
      : '';

    return '' +
      '<div class="ssp-row"><span>📅 ' + (it.created_date || '—') +
        (age != null ? ' (' + age + 'd)' : '') + '</span>' +
      '<span>⚡ ' + vel30 + velLbl + ' vs ' + velLife + '/d</span></div>' +
      '<div class="ssp-row"><span>💰 30d: ' + brl(rev30) + '</span>' +
      '<span>⭐ ' + starTxt + (rcount ? ' (' + n(rcount) + ')' : '') + '</span>' +
      '<span>📦 ' + n(it.stock) + ' un.</span></div>' +
      '<div class="ssp-row ssp-profit"><span>🧮 Pós-Shopee: ' + brl(gross) + '</span></div>' +
      '<div class="ssp-row ssp-cmv"><span>🎯 CMV Teto (20%): ' + brl(cmv) + '</span></div>' +
      breachRow +
      '<div class="ssp-row ssp-delta" data-itemid="' + it.itemid + '">' +
        '<span>📈 24h: <i>carregando…</i></span></div>';
  }

  // lista remota de trackados: merge com localStorage — itens que só
  // existem local sobem pro server, itens de outros PCs baixam pra cá
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'SSP_TRACK_RESULT') {
      var remoteIds = {};
      (msg.items || []).forEach(function (r) {
        var rid = String(r.item_id);
        remoteIds[rid] = 1;
        if (!tracked[rid]) {
          tracked[rid] = { name: r.name || '', shopid: r.shop_id,
                           at: new Date(r.created_at).getTime() };
        }
      });
      // remoto é autoridade: item local que sumiu do server e já passou
      // da carência foi desmarcado em outro PC/dashboard → some daqui.
      // item muito novo sem confirmação remota sobe (push pode ter falhado)
      var syncGraceMs = 10 * 60 * 1000;
      Object.keys(tracked).forEach(function (id) {
        if (remoteIds[id]) return;
        var age = tracked[id] && tracked[id].at
          ? Date.now() - tracked[id].at : Infinity;
        if (age > syncGraceMs) delete tracked[id];
        else pushTrack(id, true, tracked[id]);
      });
      saveTracked(); updatePins(); refreshTopBar();
      return;
    }
    if (msg && msg.type === 'SSP_TRACK_STATS_RESULT') {
      trkStats = msg.stats || {};
      var panel = document.getElementById('ssp-trkpanel');
      if (panel) renderTrackedPanel(panel);
      return;
    }
    if (msg && msg.type === 'SSP_TRACK_SCORES_RESULT') {
      // limpeza: sinal MONITOR, ou sem dados — mas item trackado há
      // menos de 48h ganha carência (ainda não teve revisita p/ gerar
      // snapshot)
      var scores = msg.scores || {};
      var pn = document.getElementById('ssp-trkpanel');
      // se a consulta veio vazia (rede/supabase falhou), não apaga nada —
      // "nenhuma linha" é diferente de "consulta quebrou"
      if (Object.keys(tracked).length && !Object.keys(scores).length) {
        window.alert('Não consegui consultar os scores no Supabase — ' +
          'nada foi removido. Tenta de novo em instantes.');
        if (pn) renderTrackedPanel(pn);
        return;
      }
      var graceMs = 48 * 3600 * 1000;
      var noData = 0, monitor = 0;
      var weak = Object.keys(tracked).filter(function (id) {
        var s = scores[id];
        var t = tracked[id];
        var age = t && t.at ? Date.now() - t.at : Infinity;
        if (!s) {
          if (age > graceMs) { noData++; return true; }
          return false;
        }
        if (s.sinal === 'MONITOR') { monitor++; return true; }
        return false;
      });
      var total = Object.keys(tracked).length;
      if (!weak.length ||
          window.confirm('De ' + total + ' trackados: ' + monitor +
            ' sinal MONITOR + ' + noData + ' sem dados (48h+) = ' +
            weak.length + ' removidos. Confirma?')) {
        weak.forEach(function (id) {
          delete tracked[id];
          pushTrack(id, false, {});
        });
        saveTracked(); updatePins(); refreshTopBar();
      }
      if (pn) renderTrackedPanel(pn);
      return;
    }
    if (msg && msg.type === 'SSP_DELTA_RESULT') {
      // atualiza todos os alvos com esse itemid — badge do card E
      // bloco do drawer (ambos exibem o mesmo delta)
      document.querySelectorAll(
        '.ssp-delta[data-itemid="' + msg.itemid + '"]'
      ).forEach(function (el) {
        var txt = msg.sales != null ? '+' + msg.sales + ' vendas/dia' : 'sem baseline';
        el.innerHTML = '<span>📈 24h: ' + txt + '</span>';
      });
      return;
    }
    if (msg && msg.type === 'SSP_ITEM_STATS_RESULT') {
      // último snapshot do banco completa o que a PDP não expõe:
      // sold_30d, stock — preenche os spans do Plano de Entrada
      var s = msg.stats;
      var it = items.get(String(msg.itemid));
      if (!s) return;
      if (it) {
        if (it.sold_30_days == null && s.sold_30_days != null)
          it.sold_30_days = s.sold_30_days;
        if (it.stock == null && s.stock != null) it.stock = s.stock;
        if (it.historical_sold == null && s.historical_sold != null)
          it.historical_sold = s.historical_sold;
      }
      var vol = document.getElementById('ssp-pd-vol');
      var rev = document.getElementById('ssp-pd-rev');
      var stk = document.getElementById('ssp-pd-stock');
      var vel = document.getElementById('ssp-pd-vel');
      var vlf = document.getElementById('ssp-pd-vlife');
      var price = it ? (it.price || it.price_min || s.price || 0)
                     : (s.price || 0);
      var s30 = s.sold_30_days || 0;
      if (vol && s30) vol.textContent = n(s30);
      if (rev && s30 && price) rev.textContent = brl(s30 * price);
      if (stk && s.stock != null) stk.textContent = n(s.stock);
      if (vel && s30) {
        var age2 = it && it.age_days;
        var win2 = age2 != null ? Math.min(30, Math.max(age2, 1)) : 30;
        vel.textContent = (s30 / win2).toFixed(1);
      }
      if (vlf && it && it.age_days && s.historical_sold) {
        vlf.textContent =
          (s.historical_sold / Math.max(it.age_days, 1)).toFixed(1);
      }
      return;
    }
  });

  // ======================================================================
  // C) PDP Super-Drawer
  // ======================================================================
  function currentPdpItemId() {
    var ids = parseIds(location.href);
    return ids ? ids.itemid : null;
  }

  // a PDP exibe "X Vendidos" no topo = acumulado total = historical_sold.
  // Como o item/get morreu (anti-bot), o DOM é a única fonte passiva
  // desse campo — raspa e grava no item pra ir no próximo flush de ingest
  function pdpSoldFromDom() {
    var els = document.querySelectorAll('div, span, button, section');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || '').trim();
      var m = t.match(/^([\d.,]+)\s*(mil)?\s*[Vv]endidos?/);
      if (m) {
        var v = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
        return Math.round(v * (m[2] ? 1000 : 1));
      }
    }
    return null;
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

    if (it.historical_sold == null) {
      var hs = pdpSoldFromDom();
      if (hs != null) {
        it.historical_sold = hs;
        queueItem(it);
      }
    }

    // só reconstrói se mudou (evita flicker/jank a cada repaint)
    var key = itemid + ':' + ((it.models || []).length) + ':' +
              ((ratings.get(itemid) || []).length) + ':' +
              (trackerOn ? '1' : '0') + ':' + (isTracked(itemid) ? 't' : '');
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
      '<div class="ssp-drawer-head">🎯 ShopeeSniper <span>' +
        // tracker pausado: esconde o botão, exceto se já trackado
        // (permite desmarcar)
        ((trackerOn || isTracked(itemid))
          ? '<button id="ssp-track">' +
            (isTracked(itemid) ? '📌 Trackado' : '📌 Track') + '</button>'
          : '') +
        '<button id="ssp-toggle">▾</button></span></div>' +
      '<div class="ssp-drawer-body">' +
        entryPlanHTML(it, itemid) +
        skuTableHTML(it) +
        sellerCardHTML(it) +
        painMinerHTML(itemid) +
        mediaHTML(it) +
      '</div>';
    drawer.querySelector('#ssp-toggle').onclick = function () {
      drawer.classList.toggle('collapsed');
    };
    var trkBtn = drawer.querySelector('#ssp-track');
    if (trkBtn) {
      trkBtn.onclick = function (ev) {
        toggleTrack(it);
        ev.target.textContent =
          isTracked(itemid) ? '📌 Trackado' : '📌 Track';
      };
    }
    // completa o bloco com o que a PDP não expõe: delta 24h + último
    // snapshot (sold_30d, stock) — mesmo fetch do selo do card
    safeSend({ type: 'SSP_DELTA', itemid: itemid });
    safeSend({ type: 'SSP_ITEM_STATS', itemid: itemid });
    setTimeout(function () {
      var d = drawer.querySelector('.ssp-delta-pdp');
      if (d && d.innerText.indexOf('carregando') !== -1) {
        d.innerHTML = '<span>📈 24h: —</span>';
      }
    }, 12000);
    drawer.querySelectorAll('.ssp-media-dl').forEach(function (b) {
      b.onclick = function () {
        safeSend({ type: 'SSP_DOWNLOAD', url: b.dataset.url,
                   filename: b.dataset.name });
      };
    });
  }

  // estoque do SKU: v4 antigo usa m.stock; payloads novos (pdp/get_pc)
  // usam normal_stock / stock_info.{total,seller_stock[0].stock,...}
  function modelStock(m) {
    var cands = [m.stock, m.normal_stock, m.available_stock, m.total_stock];
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] === 'number') return cands[i];
    }
    var si = m.stock_info;
    if (si && typeof si === 'object') {
      var k2 = ['total', 'total_stock', 'available_stock', 'stock'];
      for (var j = 0; j < k2.length; j++) {
        if (typeof si[k2[j]] === 'number') return si[k2[j]];
      }
      var lists = [si.seller_stock, si.shopee_stock, si.stock_list];
      for (var l = 0; l < lists.length; l++) {
        var arr = lists[l];
        if (Array.isArray(arr) && arr[0] &&
            typeof arr[0].stock === 'number') return arr[0].stock;
      }
    }
    return null;
  }

  function skuTableHTML(it) {
    var models = it.models || [];
    if (!models.length) {
      return '<div class="ssp-section"><h4>📦 Variações (SKU)</h4>' +
        '<p>Sem dados de variação neste payload.</p></div>';
    }
    var stocks = models.map(modelStock);
    if (stocks.every(function (s) { return s == null; })) {
      // shape novo não mapeado — loga as chaves pra calibrar o parser
      console.log('[ShopeeSniper] model sem stock — chaves:',
        Object.keys(models[0]),
        'stock_info:', JSON.stringify(models[0].stock_info || null));
    }
    var totalStock = stocks.reduce(function (s, x) { return s + (x || 0); }, 0) || 1;
    var rows = models.map(function (m, i) {
      var share = ((stocks[i] || 0) / totalStock * 100).toFixed(0);
      return '<tr><td>' + (m.name || m.model_name || '—') + '</td>' +
             '<td>' + brl(m.price) + '</td>' +
             '<td>' + n(stocks[i]) + '</td>' +
             '<td>' + share + '%</td></tr>';
    }).join('');
    return '<div class="ssp-section"><h4>📦 Variações (SKU)</h4>' +
      '<table class="ssp-table"><thead><tr><th>Variação</th><th>Preço</th>' +
      '<th>Estoque</th><th>Share</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>';
  }

  function sellerCardHTML(it) {
    var shop = shops.get(String(it.shopid)) || {};
    var loc = shop.location || it.shop_location || it.shop_loc || '—';
    var missing = shop.rating_star == null;
    return '<div class="ssp-section"><h4>🏪 Vendedor</h4><div class="ssp-grid">' +
      '<span>Rating: <b>' + (shop.rating_star != null ? shop.rating_star.toFixed(2) + '★' : '—') + '</b></span>' +
      '<span>Chat: <b>' + (shop.response_rate != null ? shop.response_rate + '%' : '—') + '</b></span>' +
      '<span>Resp. média: <b>' + (shop.response_time || '—') + '</b></span>' +
      '<span>Seguidores: <b>' + n(shop.follower_count) + '</b></span>' +
      '<span>Local: <b>' + loc + '</b></span>' +
      '</div>' + (missing ? '<i class="ssp-hint">🔎 Varrer/rolar até a loja carrega o resto</i>' : '') +
      '</div>';
  }

  var PAIN_KW = {
    'Qualidade': ['rasgou', 'quebrou', 'frágil', 'defeito', 'descosturou'],
    'Tamanho': ['pequeno', 'grande', 'tamanho', 'não serviu'],
    'Entrega': ['atraso', 'demorou', 'embalagem', 'amassado'],
    'Foto': ['diferente', 'foto', 'enganoso']
  };

  // como atacar cada categoria de reclamação na entrada
  var PAIN_ACT = {
    'Qualidade': 'fornecedor com material melhor — e foto real provando',
    'Tamanho': 'tabela de medidas + modelo de referência nas fotos',
    'Entrega': 'embalagem reforçada — e mostra ela na foto, vira diferencial',
    'Foto': 'foto própria do produto real — o dele engana e o cliente sente'
  };

  function painCounts(itemid) {
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
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return { neg: neg.length,
             top: keys.map(function (k) { return [k, counts[k]]; }) };
  }

  // ⚔️ Plano de Entrada: transforma cada falha detectada do concorrente
  // em ação concreta. Falha forte = coisa que realmente derruba venda
  // (chat ignorado, nota baixa com reclamação recorrente).
  function entryPlanHTML(it, itemid) {
    var shop = shops.get(String(it.shopid)) || {};
    var price = it.price || it.price_min || 0;
    var sold = it.sold || it.sold_30_days || 0;
    var rating = (it.item_rating || {}).rating_star;
    var rc = (it.item_rating || {}).rating_count;
    var rcount = Array.isArray(rc)
      ? rc.reduce(function (a, b) { return a + (+b || 0); }, 0) : rc;
    if (rcount == null) rcount = pdpReviewCountDom();
    var moves = [], fortes = 0, meds = 0;
    function add(sev, tag, title, act) {
      moves.push({ sev: sev, tag: tag, title: title, act: act });
      if (sev === 'alta') fortes++;
      else if (sev === 'med') meds++;
    }

    // 💬 chat — seller que ignora cliente sangra conversão
    if (shop.response_rate != null && shop.response_rate < 70) {
      add(shop.response_rate < 45 ? 'alta' : 'med', '💬',
          'Chat ' + shop.response_rate + '% — ele ignora cliente',
          'responde em minutos que o algoritmo te ranqueia acima');
    }
    // ⭐ produto que vende reclamando
    if (rating != null && rating < 4.6) {
      add(rating < 4.4 ? 'alta' : 'med', '⭐',
          'Nota ' + rating.toFixed(1) + '★ em ' + n(rcount) + ' avaliações',
          'versão corrigida no título/fotos te faz parecer a escolha óbvia');
    }
    // ⭐ prova social zerada — nota alta com pouquíssimas avaliações
    // é incumbente ainda não consolidado, fácil de ultrapassar
    if (rating != null && rating >= 4.7 && rcount != null &&
        rcount > 0 && rcount < 15) {
      add('med', '⭐', 'Nota alta mas só ' + n(rcount) + ' avaliações',
          'prova social fraca — tuas primeiras 15-20 reviews boas te colocam na frente');
    }
    // 😤 top reclamação → fix direto
    var pains = painCounts(itemid);
    if (pains.top.length) {
      add('alta', '😤', 'Reclamam de ' + pains.top[0][0] +
          ' (' + pains.top[0][1] + '× nas negativas)',
          PAIN_ACT[pains.top[0][0]] || 'corrige isso e anuncia a correção');
    }
    // 📦 anúncio magro
    var nVar = (it.models || []).length;
    if (nVar && nVar <= 2) {
      add('med', '📦', 'Só ' + nVar + ' variação(ões) no anúncio',
          'kits/opções (3-6 variações) sobem teu ticket e pegam quem quer volume');
    }
    var nImg = (it.images || []).length;
    if (nImg && nImg < 6) {
      add('med', '📸', 'Poucas fotos (' + nImg + ')',
          '8-9 fotos + vídeo curto — conversão na Shopee é guerra de imagem');
    }
    // 🔥 anúncio novo vendendo = demanda quente não consolidada
    if (it.age_days != null && it.age_days <= 150 && sold >= 500) {
      add('info', '🔥', 'Anúncio de ' + it.age_days + 'd e já vendeu ' + n(sold),
          'demanda quente em consolidação — entra antes dele travar o ranking');
    }
    if (it.age_days != null && it.age_days >= 400 && rating != null && rating < 4.5) {
      add('med', '🧓', 'Anúncio velho (' + Math.round(it.age_days / 30) + 'm) e nota fraca',
          'ele acomoda — teu listing do zero chega sem histórico de reclamação');
    }
    // � internacional — frete longo é a maior brecha explorável:
    // tu compra nacional e entrega em dias, ele entrega em semanas
    if (isIntl(it)) {
      add('med', '🌎', 'Vendedor internacional — entrega de semanas',
          'fornecedor nacional + envio em 3-5d vira o teu pitch de venda');
    }
    // �🏪 loja mal avaliada
    if (shop.rating_star != null && shop.rating_star < 4.7) {
      add('med', '🏪', 'Loja dele avaliada ' + shop.rating_star.toFixed(2) + '★',
          'reputação é teu diferencial: atendimento rápido + review inicial forte');
    }
    // 💸 economia — a conta tem que fechar antes de brigar
    var liq = price ? grossAfterShopee(price) : 0;
    var cmv = price ? cmvTeto(price) : 0;
    var f = price ? feeBreakdown(price) : null;
    var feeTxt = f
      ? 'Taxas/un: <b>' + brl(f.comm + f.fixed + f.fs + f.tax + f.ads) + '</b>' +
        ' (comm ' + brl(f.comm) + ' · fixa ' + brl(f.fixed) +
        ' · frete ' + brl(f.fs) + ' · imposto ' + brl(f.tax) +
        (f.ads ? ' · ads ' + brl(f.ads) : '') + ')'
      : '';
    // mesmo bloco de dados do selo do card — p/ conferir os números
    // dentro do drawer sem sair da PDP. Campos que o payload da PDP não
    // traz (sold_30d, stock, idade) chegam async via SSP_ITEM_STATS
    var age = it.age_days;
    var win = age != null ? Math.min(30, Math.max(age, 1)) : 30;
    var hist = it.historical_sold || 0;
    var vel30 = sold ? (sold / win).toFixed(1) : null;
    var velLife = age ? (hist / Math.max(age, 1)).toFixed(1) : null;
    var econ = price
      ? '<div class="ssp-grid">' +
        '<span>Sobras/un: <b class="ssp-profit">' + brl(liq) + '</b></span>' +
        '<span>Fornecedor até: <b class="ssp-cmv">' + brl(cmv) + '</b></span>' +
        '<span>📅 ' + (it.created_date || '—') +
          (age != null ? ' (' + age + 'd)' : '') + '</span>' +
        '<span>⭐ ' + (rating != null ? rating.toFixed(1) : '—') +
          (rcount ? ' (' + n(rcount) + ')' : '') + '</span>' +
        '<span>📦 <b id="ssp-pd-stock">' +
          (it.stock != null ? n(it.stock) : '—') + '</b> un.</span>' +
        '<span>⚡ <b id="ssp-pd-vel">' + (vel30 || '—') + '</b>/d (' +
          win + 'd) vs <b id="ssp-pd-vlife">' + (velLife || '—') +
          '</b>/d</span>' +
        '<span>Vol. 30d: <b id="ssp-pd-vol">' +
          (sold ? n(sold) : '—') + '</b></span>' +
        '<span>Receita 30d: <b id="ssp-pd-rev">' +
          (sold ? brl(sold * price) : '—') + '</b></span>' +
        '</div>' +
        '<div class="ssp-row ssp-delta ssp-delta-pdp" data-itemid="' +
          itemid + '"><span>📈 24h: <i>carregando…</i></span></div>' +
        '<i class="ssp-hint">' + feeTxt + '</i>'
      : '';
    if (price && cmv <= 0) {
      add('alta', '💸', 'Conta não fecha a 20% — preço só cobre taxas',
          'baixa margem alvo ou negocia fornecedor bem mais barato');
    } else if (price && liq < 5) {
      add('med', '💸', 'Sobra só ' + brl(liq) + '/un',
          'margem fina — qualquer frete/erro do fornecedor te quebra');
    }

    // veredito
    var verdict, cls;
    if (shop.rating_star == null && shop.response_rate == null &&
        rating == null) {
      verdict = '🔍 Dados magros — 🔎 Varrer + rola até loja/avaliações pra calibrar';
      cls = 'dim';
    } else if (fortes >= 2) {
      verdict = '🟢 ESPAÇO PRA ENTRAR — ' + fortes + ' falhas fortes + demanda provada';
      cls = 'ok';
    } else if (fortes === 1 || meds >= 2 || moves.length >= 3) {
      verdict = '🟡 DÁ PRA BRIGAR — confirma a saída: 📌 tracka e acompanha 1 semana';
      cls = 'warn';
    } else {
      verdict = '🔴 Incumbente sólido — só entra com produto/preço claramente melhor';
      cls = 'bad';
    }

    var lis = moves.map(function (m) {
      return '<li class="sev-' + m.sev + '"><b>' + m.tag + ' ' + m.title +
             '</b><span>' + m.act + '</span></li>';
    }).join('');
    return '<div class="ssp-section"><h4>⚔️ Plano de Entrada</h4>' +
      econ +
      '<p class="ssp-verdict ' + cls + '">' + verdict + '</p>' +
      (lis ? '<ul class="ssp-plan">' + lis + '</ul>' : '') +
      (shop.rating_star == null ? '<i class="ssp-hint">🔎 Varrer até a loja pra detectar falhas de atendimento</i>' : '') +
      '</div>';
  }

  // PDP mostra "N Avaliações" como texto — fallback quando o payload
  // não traz item_rating.rating_count
  function pdpReviewCountDom() {
    var m = ((document.body && document.body.innerText) || '')
      .match(/(\d+(?:[.,]\d+)?)\s*(mil\s*)?Avalia/i);
    if (!m) return null;
    var v = parseFloat(m[1].replace('.', '').replace(',', '.'));
    return Math.round(v * (m[2] ? 1000 : 1));
  }

  // distribuição de estrelas raspada do DOM da PDP — os filtros de
  // review ("1 Estrela (1,6mil)") renderizam como texto, não precisa
  // de chamada de API pra montar o mapa de insatisfação
  function starDistFromDom() {
    var t = (document.body && document.body.innerText) || '';
    var out = {}, m, re = /([1-5])\s*Estrela\s*\(([^)]+)\)/g;
    while ((m = re.exec(t))) out[m[1] + '★'] = m[2];
    return out;
  }

  function painMinerHTML(itemid) {
    var pains = painCounts(itemid);
    var lines = pains.top.map(function (t) {
      return '<li>' + t[0] + ': <b>' + t[1] + '×</b></li>';
    }).join('');
    var dist = starDistFromDom();
    var distTxt = ['3★', '2★', '1★'].filter(function (s) { return dist[s]; })
      .map(function (s) { return s + ' ' + dist[s]; }).join(' · ');
    return '<div class="ssp-section"><h4>😤 Pain Miner (1–3★)</h4>' +
      '<p>' + pains.neg + ' reviews negativas capturadas' +
      (distTxt ? ' · ' + distTxt : '') + '</p>' +
      '<ul class="ssp-pain">' + (lines || '<li>sem padrões ainda</li>') + '</ul>' +
      (pains.neg < 10 ? '<i class="ssp-hint">clica nas estrelas 1–3 na seção de avaliações pra minerar mais</i>' : '') +
      '</div>';
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
    var head = 'itemid;shopid;nome;preco;vendidos_30d;historical_sold;estoque;criado;age_days;rating;tracked\n';
    var rows = Array.from(items.values()).map(function (it) {
      var rating = (it.item_rating && it.item_rating.rating_star) || '';
      return [it.itemid, it.shopid, '"' + String(it.name || '').replace(/"/g, '""') + '"',
        it.price || it.price_min || '', it.sold || '', it.historical_sold || '',
        it.stock != null ? it.stock : '', it.created_date || '', it.age_days != null ? it.age_days : '',
        rating, isTracked(it.itemid || it.item_id) ? 1 : 0].join(';');
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

  harvestEmbeddedData();
  setTimeout(harvestEmbeddedData, 3000); // scripts podem hidratar depois
  // SSR hidrata em etapas — re-harvest periódico pega os que chegam tarde
  setInterval(harvestEmbeddedData, 10000);
  // baixa os itens 📌 do Supabase (sync entre PCs) → SSP_TRACK_RESULT
  safeSend({ type: 'SSP_TRACK_LIST' });
  schedulePaint();
})();
