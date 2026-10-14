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
    // catch-all: qualquer resposta /api/v4/ é clonada; se tiver dados de
    // item/shop/ratings dentro, vira evento (resiste a mudança de rota)
    if (url.indexOf('/api/v4/') !== -1) return url;
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
      console.debug('[ShopeeSniper]', route);
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

  var bootstrapTries = 0;
  function bootstrap() {
    if (window.__SSP_SEEN || bootstrapTries > 3) return;
    bootstrapTries++;
    setTimeout(function () {
      if (window.__SSP_SEEN || !hasProductCards()) return;
      var url = guessApiCall();
      if (!url) return;
      console.debug('[ShopeeSniper] bootstrap:', url);
      fetch(url, {
        credentials: 'include',
        headers: { 'x-api-source': 'pc' }
      }).catch(function () {});
    }, 2000);
  }

  window.addEventListener('load', bootstrap);
  // SPA: mudança de rota sem reload
  setInterval(function () {
    if (!window.__SSP_SEEN && hasProductCards()) bootstrap();
  }, 4000);

  console.debug('[ShopeeSniper] interceptor ativo');
})();
