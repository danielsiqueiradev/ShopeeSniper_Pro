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
    for (var i = 0; i < ROUTES.length; i++) {
      if (url && url.indexOf(ROUTES[i]) !== -1) return ROUTES[i];
    }
    return null;
  }

  function emit(route, payload) {
    try {
      window.postMessage({
        source: 'SHOPEE_SNIPER_INTERCEPT',
        route: route,
        payload: payload,
        captured_at: Date.now() / 1000
      }, '*');
    } catch (e) { /* nunca quebrar a página */ }
  }

  function handleJson(route, json) {
    try {
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

  console.debug('[ShopeeSniper] interceptor ativo');
})();
