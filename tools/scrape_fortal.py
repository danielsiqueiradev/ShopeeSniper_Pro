#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Catálogo Fortal Import (fortalimport.com.br) — o site é SPA React que
# lê o catálogo da RPC pública get_site_catalog no Supabase deles.
# Bater direto na RPC é estável, rápido e completo (sem paginar HTML).
# Uso:  python tools/scrape_fortal.py [saida.csv]
# Saída: CSV ';' compatível com a aba 📦 Catálogo do dashboard.

import csv, json, sys, urllib.request

URL = ('https://vntichnezfywbfyhjrvr.supabase.co/rest/v1/rpc/'
       'get_site_catalog')
KEY = ('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJl'
       'ZiI6InZudGljaG5lemZ5d2JmeWhqcnZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE'
       '3NTYxNjE1ODcsImV4cCI6MjA3MTczNzU4N30.Q7mKBNnRqfly8-U0f9UC1DY9a'
       'GTPi4lJ_KLFoGc2l2g')


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'catalogo_fortal.csv'
    req = urllib.request.Request(
        URL, method='POST', data=b'{}',
        headers={'apikey': KEY, 'Authorization': 'Bearer ' + KEY,
                 'Content-Type': 'application/json'})
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    cats = {c['id']: c['name'] for c in d['categories']}
    rows = []
    for p in d['products']:
        nome = (p.get('name') or '').strip()
        info = (p.get('info') or '').strip()
        if info and info.lower() not in nome.lower():
            nome += ' ' + info
        rows.append({
            'nome': nome, 'sku': p.get('ref') or '', 'ean': '',
            'preco': '', 'url': '',
            'departamento': cats.get(p.get('category_id'),
                                     cats.get(p.get('subcategory_id'), '')),
            'embalagem': ('cx ' + p['cx'] if p.get('cx') else ''),
        })
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, delimiter=';',
                           fieldnames=['nome', 'sku', 'ean', 'preco', 'url',
                                       'departamento', 'embalagem'])
        w.writeheader()
        w.writerows(rows)
    print(f'{len(rows)} produtos -> {out}')


if __name__ == '__main__':
    main()
