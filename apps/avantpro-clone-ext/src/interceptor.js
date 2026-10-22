/**
 * ShopeeSniper Pro — interceptor (MAIN world)
 *
 * Monkey-patch em window.fetch e XMLHttpRequest pra clonar passivamente
 * as respostas JSON da API interna v4 da Shopee BR. Não bloqueia nem altera
 * requests — apenas lê a resposta e emite um evento via postMessage.
 *
 * Normalização feita aqui:
 *  - preços vêm ×100000 (R$ 49,90 → 4990000) → divide por 100000
 *  - ctime (unix s) → created_date (DD/MM/YYYY) + age_days
 */
(function () {
  'use strict';

  var ROUTES = [
    '/api/v4/search/search_items',
    '/api/v4/recommend/recommend',
    '/api/v4/pdp/get_pc',
    '/api/v4/item/get',
    '/api/v4/shop/get_shop_base',
    '/api/v4/item/get_ratings'
  ];

  var PRICE_KEYS = {
    price: 1, price_min: 1, price_max: 1,
    price_min_before_discount: 1, price_max_before_discount: 1,
    price_before_discount: 1, raw_price: 1
  };

  function normalizePrices(node) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) normalizePrices(node[i]);
    } else if (node && typeof node === 'object') {
      for (var k in node) {
        var v = node[k];
        if (PRICE_KEYS[k] && typeof v === 'number') {
          node[k] = v / 100000;
        } else {
          normalizePrices(v);
        }
      }
    }
    return node;
  }

  function enrichCtime(item) {
    var ctime = item && item.ctime;
    if (typeof ctime === 'number' && ctime > 0) {
      var d = new Date(ctime * 1000);
      item.created_date = ('0' + d.getDate()).slice(-2) + '/' +
        ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
      item.age_days = Math.max(0, Math.floor((Date.now() / 1000 - ctime) / 86400));
    }
    return item;
  }

  function enrichItems(node) {
    if (Array.isArray(node)) {
      node.forEach(enrichItems);
    } else if (node && typeof node === 'object') {
      if (node.ctime) enrichCtime(node);
      for (var k in node) enrichItems(node[k]);
    }
  }

  function routeOf(url) {
    if (!url) return null;
    for (var i = 0; i < ROUTES.length; i++) {
      if (url.indexOf(ROUTES[i]) !== -1) return ROUTES[i];
    }
    // catch-all: qualquer resposta /api/ é clonada (v2, v4, futuras); se
    // tiver dados de item/shop/ratings dentro, vira evento — resiste a
    // mudança de versão de rota (get_ratings migrou pra v2, por ex.)
    if (url.indexOf('/api/') !== -1) return url;
    return null;
  }

  var INTERESTING_KEYS = {
    itemid: 1, item_id: 1, item_basic: 1, ratings: 1,
    shopid: 1, shop_id: 1, models: 1
  };

  function looksInteresting(node, depth, budget) {
    // budget: para de varrer depois de ~300 nós (payloads gigantes)
    if (depth > 6 || budget.n > 300 || !node || typeof node !== 'object')
      return false;
    for (var k in node) {
      if (INTERESTING_KEYS[k]) return true;
      if (++budget.n > 300) return false;
      if (looksInteresting(node[k], depth + 1, budget)) return true;
    }
    return false;
  }

  function emit(route, payload) {
    try {
      window.__SSP_SEEN = true;
      window.postMessage({
        source: 'SHOPEE_SNIPER_INTERCEPT',
        route: route,
        payload: payload,
        captured_at: Date.now() / 1000
      }, '*');
      console.log('[ShopeeSniper]', route);
    } catch (e) { /* nunca quebrar a página */ }
  }

  function handleJson(route, json) {
    try {
      if (!looksInteresting(json, 0, { n: 0 })) return;
      var clean = normalizePrices(JSON.parse(JSON.stringify(json)));
      enrichItems(clean);
      emit(route, clean);
    } catch (e) { /* payload não-JSON ou circular: ignora */ }
  }

  // ---------- fetch ----------
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url);
    var route = routeOf(url);
    return origFetch.apply(this, args).then(function (resp) {
      if (route) {
        resp.clone().json()
          .then(function (j) { handleJson(route, j); })
          .catch(function () {});
      }
      return resp;
    });
  };

  // ---------- XMLHttpRequest ----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssp_route = routeOf(typeof url === 'string' ? url : String(url));
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (xhr.__ssp_route) {
      xhr.addEventListener('load', function () {
        try {
          var j = JSON.parse(xhr.responseText);
          handleJson(xhr.__ssp_route, j);
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---------- bootstrap ativo ----------
  // Páginas com SSR (categoria/oficial) renderizam o grid no HTML inicial,
  // sem chamar a API → nada pra interceptar. Se a página tem cards mas
  // nenhum payload v4 passou, repetimos a chamada que a própria Shopee
  // faria (mesma origem, cookies do usuário). O fetch passa pelo nosso
  // hook, então a resposta alimenta o pipeline normal.
  function guessApiCall() {
    var u = location.href;
    var kw = (u.match(/[?&]keyword=([^&]+)/) || [])[1];
    var cat = (u.match(/cat\.(\d+)/) || [])[1];
    if (kw) {
      return '/api/v4/search/search_items?by=relevancy&keyword=' +
        decodeURIComponent(kw) +
        '&limit=60&newest=0&order=desc&page_type=search' +
        '&scenario=PAGE_GLOBAL_SEARCH&version=2';
    }
    if (cat) {
      return '/api/v4/search/search_items?by=pop&match_id=' + cat +
        '&limit=60&newest=0&order=desc&page_type=search' +
        '&scenario=PAGE_CATEGORY_SEARCH&version=2';
    }
    return null;
  }

  function hasProductCards() {
    return document.querySelectorAll(
      'a[href*="-i."], a[href*="/product/"]').length >= 4;
  }

  function parseIdsFromHref(href) {
    var m = href && href.match(/-i\.(\d+)\.(\d+)/);
    if (m) return { shopid: m[1], itemid: m[2] };
    m = href && href.match(/\/product\/(\d+)\/(\d+)/);
    return m ? { shopid: m[1], itemid: m[2] } : null;
  }

  // Circuit breaker: uma chamada proativa tomando 4xx = Shopee
  // flagrando bot → para TUDO na hora pra não escalar o bloqueio.
  var sspBackoff = false;

  // Modo proativo é OPT-IN: fetches extras são o que o anti-bot enxerga.
  // Padrão = 100% passivo (só lê respostas que a própria página pede).
  // Pra reativar: localStorage.ssp_proactive = '1' e recarregar.
  function proactiveEnabled() {
    try { return localStorage.getItem('ssp_proactive') === '1'; }
    catch (e) { return false; }
  }

  function jitter(minMs, maxMs) {
    return minMs + Math.random() * (maxMs - minMs);
  }

  function safeApiFetch(url, force) {
    if (!force && !proactiveEnabled()) return Promise.resolve();
    if (sspBackoff) return Promise.resolve();
    return fetch(url, {
      credentials: 'include',
      headers: { 'x-api-source': 'pc' }
    }).then(function (r) {
      if (r.status >= 400) {
        sspBackoff = true;
        console.log('[ShopeeSniper] API ' + r.status +
                    ' — backoff ativo, chamadas proativas paradas');
      }
    }).catch(function () { sspBackoff = true; });
  }

  // Fallback definitivo: pega itemid/shopid dos cards do DOM e chama
  // /api/v4/item/get pra cada um — funciona em qualquer página com grid.
  function fetchDetailsFromDom(force) {
    var seen = {};
    var queue = [];
    var links = document.querySelectorAll(
      'a[href*="-i."], a[href*="/product/"]');
    for (var i = 0; i < links.length && queue.length < 8; i++) {
      var ids = parseIdsFromHref(links[i].href);
      if (ids && !seen[ids.itemid]) {
        seen[ids.itemid] = 1;
        queue.push(ids);
      }
    }
    console.log('[ShopeeSniper] fetch item/get p/ ' + queue.length + ' itens do DOM');
    (function next() {
      var ids = queue.shift();
      if (!ids || sspBackoff) return;
      safeApiFetch('/api/v4/item/get?itemid=' + ids.itemid +
                   '&shopid=' + ids.shopid, force)
        .finally(function () { setTimeout(next, jitter(1500, 3500)); });
    })();
  }

  // ---------- PDP: dados ricos que a página só carrega lazy ----------
  // Reviews e shop só descem quando o usuário rola até as seções.
  // A gente dispara as MESMAS chamadas que a página faria (cookies do
  // usuário, mesmo origin) — a resposta passa pelo hook e alimenta tudo.
  var pdpDone = {};
  function pdpIds() {
    var m = location.href.match(/-i\.(\d+)\.(\d+)/) ||
            location.href.match(/\/product\/(\d+)\/(\d+)/);
    return m ? { shopid: m[1], itemid: m[2] } : null;
  }

  function fetchPdpData(force) {
    if (!force && !proactiveEnabled()) return;
    var ids = pdpIds();
    if (!ids || pdpDone[ids.itemid]) return;
    pdpDone[ids.itemid] = 1;
    console.log('[ShopeeSniper] PDP: puxando item + loja + reviews 1-3★');

    // item completo: models com preço, ctime, stock, historical_sold
    setTimeout(function () {
      safeApiFetch('/api/v4/item/get?itemid=' + ids.itemid +
                   '&shopid=' + ids.shopid, force);
    }, jitter(1000, 2500));

    // dados do vendedor (card 🏪 do drawer)
    setTimeout(function () {
      safeApiFetch('/api/v4/shop/get_shop_base?shopid=' + ids.shopid +
                   '&need_cancel_rate=true&version=1', force);
    }, jitter(3000, 5000));

    // reviews por estrela (type=1|2|3) — pain miner filtra rating_star <= 3
    [1, 2, 3].forEach(function (star, i) {
      setTimeout(function () {
        safeApiFetch('/api/v4/item/get_ratings?itemid=' + ids.itemid +
                     '&shopid=' + ids.shopid +
                     '&limit=20&offset=0&type=' + star + '&filter=0', force);
      }, jitter(6000, 9000) + i * jitter(1200, 2200));
    });
  }

  var bootstrapTries = 0;
  function bootstrap() {
    if (bootstrapTries > 3) return;
    bootstrapTries++;
    setTimeout(function () {
      fetchPdpData();
      if (!hasProductCards()) return;
      if (!window.__SSP_SEEN) {
        var url = guessApiCall();
        if (url) {
          console.log('[ShopeeSniper] bootstrap:', url);
          safeApiFetch(url);
        }
      }
      // detalhes sempre: payloads de listagem podem vir magros (sem
      // price/sold/ctime) — item/get traz o item completo por card
      if (proactiveEnabled() && !window.__SSP_DETAILS_DONE) {
        window.__SSP_DETAILS_DONE = true;
        setTimeout(fetchDetailsFromDom, 1500);
      }
    }, 2000);
  }

  window.addEventListener('load', bootstrap);
  // SPA: mudança de rota sem reload — PDP nova também dispara fetchPdpData
  setInterval(function () {
    fetchPdpData();
    if (!window.__SSP_SEEN && hasProductCards()) bootstrap();
  }, 4000);

  // Chamadas proativas (nossa própria fetch à API) são detectáveis de
  // qualquer jeito: a Shopee assina requests (sz_token etc.) e um fetch
  // sem assinatura é flagrado na hora. Garante flag morta mesmo se o
  // usuário tinha ativado antes — enriquecimento agora é 100% passivo
  // (botão 🔎 Varrer rola a página pra ela mesma pedir os dados).
  try { localStorage.removeItem('ssp_proactive'); } catch (e) {}

  console.log('[ShopeeSniper] interceptor ativo');
})();
