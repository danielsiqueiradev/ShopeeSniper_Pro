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
  var OPP_DEFAULT = { minSold: 30, maxSold: 300,
                      minPrice: 15, maxPrice: 120, rating: 4.7 };
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
  function toggleTrack(it) {
    var id = String(it.itemid || it.item_id);
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
      queueItem(items.get(String(id)));
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
  var ingestQueue = new Map();
  function queueItem(it) {
    var id = it.itemid || it.item_id;
    if (id) ingestQueue.set(String(id), it);
  }
  setInterval(function () {
    if (!ingestQueue.size) return;
    var list = Array.from(ingestQueue.values());
    ingestQueue.clear();
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
        Object.keys(tracked).length + '</button>' +
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
          setTimeout(function () {
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
          if (!isNaN(v)) OPP[inp.dataset.k] = v;
        });
        try {
          localStorage.setItem('ssp_opp_cfg', JSON.stringify(OPP));
        } catch (e) {}
        decorateVisibleCards();
      };
    };
    bar.querySelector('#ssp-csv').onclick = exportCSV;
  }

  function stat(label, value) {
    return '<span class="ssp-stat"><b>' + value + '</b><i>' + label + '</i></span>';
  }

  function renderTrackedPanel(p) {
    var ids = Object.keys(tracked);
    p.innerHTML = ids.length
      ? ids.map(function (id) {
          var t = tracked[id];
          var url = 'https://shopee.com.br/product/' + (t.shopid || '0') +
                    '/' + id;
          return '<div class="ssp-trk-row">' +
            '<a href="' + url + '" target="_blank" rel="noopener">' +
              (t.name || 'item ' + id) + '</a>' +
            '<button class="ssp-trk-x" data-id="' + id +
              '" title="parar de acompanhar">✕</button></div>';
        }).join('')
      : '<i>Nenhum item trackado — abra uma PDP e clique 📌 Track no drawer</i>';
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
    return '<b>💎 Cortes:</b>' +
      'Vendas/mês ' + inp('minSold') + '–' + inp('maxSold') +
      'Preço R$ ' + inp('minPrice') + '–' + inp('maxPrice') +
      'Rating &lt; ' + inp('rating', '0.1') +
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
    // 💎 Oportunidade (tese da aula): demanda real mas não saturada +
    // faixa de preço com margem p/ kit. A "brecha" (rating baixo, seller
    // intl, estoque <10) NÃO é portão — vira chips no badge, porque com
    // payloads passivos stock/rating muitas vezes faltam e o AND zerava
    if (filters.opp) {
      var s2 = it.sold || 0;
      var pr = it.price || it.price_min || 0;
      ok = ok && s2 >= OPP.minSold && s2 <= OPP.maxSold &&
           pr >= OPP.minPrice && pr <= OPP.maxPrice;
    }
    return ok;
  }

  // chips de brecha exibidos no badge — onde dá pra ganhar do líder
  function breachChips(it) {
    var chips = [];
    var rat = it.item_rating && it.item_rating.rating_star;
    if (rat != null && rat < OPP.rating) chips.push('⭐ ' + rat.toFixed(1));
    if (isIntl(it)) chips.push('🌎 intl');
    if (it.stock != null && it.stock < 10) chips.push('📦 ' + it.stock + ' un.');
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
        var lines = (card.innerText || '').split('\n')
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        it = { itemid: ids.itemid, shopid: ids.shopid,
               name: (lines[0] || '').slice(0, 200) || null };
        items.set(ids.itemid, it);
      }
      // faixa "VENDEDOR INTERNACIONAL" do próprio card — sinal de brecha
      // mesmo quando o payload não traz shop_location
      if (/internacional/i.test(card.innerText || '')) it.intl_dom = true;
      // grava fallback de volta no map — a top bar agrega daqui
      if (!it.price && !it.price_min) it.price = fb.price;
      if (!it.sold && !it.sold_30_days) it.sold = fb.sold;
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
    var vel30 = (s30 / 30).toFixed(1);
    var velLife = age ? (hist / Math.max(age, 1)).toFixed(1) : '—';
    var rev30 = s30 * price;
    var gross = grossAfterShopee(price);
    var cmv = cmvTeto(price, 0.20);
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
      '<span>⚡ ' + vel30 + '/d (30d) vs ' + velLife + '/d</span></div>' +
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
      Object.keys(tracked).forEach(function (id) {
        if (!remoteIds[id]) pushTrack(id, true, tracked[id]);
      });
      saveTracked(); updatePins(); refreshTopBar();
      return;
    }
    if (msg && msg.type === 'SSP_DELTA_RESULT') {
      var el = document.querySelector('.ssp-delta[data-itemid="' + msg.itemid + '"]');
      if (el) {
        var txt = msg.sales != null ? '+' + msg.sales + ' vendas/dia' : 'sem baseline';
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
      '<div class="ssp-drawer-head">🎯 ShopeeSniper <span>' +
        '<button id="ssp-track">' +
          (isTracked(itemid) ? '📌 Trackado' : '📌 Track') + '</button>' +
        '<button id="ssp-toggle">▾</button></span></div>' +
      '<div class="ssp-drawer-body">' +
        skuTableHTML(it) +
        sellerCardHTML(it) +
        painMinerHTML(itemid) +
        mediaHTML(it) +
      '</div>';
    drawer.querySelector('#ssp-toggle').onclick = function () {
      drawer.classList.toggle('collapsed');
    };
    drawer.querySelector('#ssp-track').onclick = function (ev) {
      toggleTrack(it);
      ev.target.textContent =
        isTracked(itemid) ? '📌 Trackado' : '📌 Track';
    };
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
