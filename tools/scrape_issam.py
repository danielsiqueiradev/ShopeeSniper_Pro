#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Scraper do catálogo público B2B Issam (b2b.issam.com.br).
# Os cards trazem data-* completos (nome, código, departamento, embalagem,
# URL) — preço vem 0.00 sem login B2B.
# Uso:  python tools/scrape_issam.py [saida.csv] [--cats cat1,cat2] [--sleep 0.3]
# Saída: CSV ';' compatível com a aba 📦 Catálogo do dashboard
# (nome / sku / extra / url / departamento).

import argparse, csv, re, sys, time, urllib.request, urllib.error

BASE = 'https://b2b.issam.com.br'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')

# categorias raiz do menu (páginas institucionais excluídas)
CATS = ['bebe', 'beleza-higiene', 'brinquedos', 'carnaval', 'confeccao',
        'copa-do-mundo', 'enfeites-de-natal', 'escolar', 'ferramentas',
        'festa', 'festa-junina', 'guarda-chuva-e-sombrinha', 'halloween',
        'inflaveis', 'pascoa', 'pet', 'u-d', 'utilidades-art-limpeza',
        'utilidades-porcelanas', 'utilidades-termicos', 'variedades',
        'vidros']

RE_PROD = re.compile(
    r'data-codigo-produto="(\d+)"[^>]*?data-nome="([^"]+)"[^>]*?'
    r'data-preco="([\d.]+)"[^>]*?data-departamento="([^"]*)"', re.S)
RE_URL = re.compile(r'window\.location=&quot;([^&]+)&quot;')
RE_EMB = re.compile(r'Embalagem:\s*([^<]+)<br>\s*Caixa Com:\s*([^<]+)')
MAX_PAGE = 80  # trava de segurança


def fetch(url, tries=3):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            return urllib.request.urlopen(req, timeout=30) \
                       .read().decode('utf-8', 'replace')
        except (urllib.error.URLError, TimeoutError) as e:
            if t == tries - 1:
                print(f'  !! falhou {url}: {e}', file=sys.stderr)
                return ''
            time.sleep(2 * (t + 1))
    return ''


def parse_page(html):
    """Um produto por bloco product-card__info — sem desalinhamento."""
    rows = []
    for seg in re.split(r'product-card__info', html)[1:]:
        seg = seg[:5000]
        m = RE_PROD.search(seg)
        if not m:
            continue
        code, nome, preco, depto = m.groups()
        url = RE_URL.search(seg)
        emb = RE_EMB.search(seg)
        rows.append({
            'nome': nome.strip(),
            'sku': code,
            'preco': preco if float(preco or 0) > 0 else '',
            'url': url.group(1).replace('\\/', '/') if url else '',
            'departamento': depto.strip(),
            'embalagem': (f'{emb.group(1).strip()} / cx {emb.group(2).strip()}'
                          if emb else ''),
        })
    return rows


def scrape_cat(cat, sleep, seen):
    """Varre a categoria até uma página não trazer produto novo."""
    total, stale = 0, 0
    for page in range(1, MAX_PAGE + 1):
        html = fetch(f'{BASE}/{cat}?page={page}')
        rows = parse_page(html)
        new = [r for r in rows if r['sku'] + r['nome'] not in seen]
        for r in new:
            seen.add(r['sku'] + r['nome'])
        total += len(new)
        if not new:
            stale += 1
            if stale >= 2:
                break
        else:
            stale = 0
        time.sleep(sleep)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out', nargs='?', default='catalogo_issam.csv')
    ap.add_argument('--cats', help='categorias separadas por vírgula')
    ap.add_argument('--sleep', type=float, default=0.4)
    a = ap.parse_args()

    cats = a.cats.split(',') if a.cats else CATS
    seen, products = set(), []
    for c in cats:
        before = len(products)
        # reusa parse_page por página mas acumulando o produto inteiro
        seen_cat = seen
        stale = 0
        for page in range(1, MAX_PAGE + 1):
            html = fetch(f'{BASE}/{c}?page={page}')
            rows = parse_page(html)
            new = [r for r in rows if r['sku'] + r['nome'] not in seen_cat]
            for r in new:
                seen_cat.add(r['sku'] + r['nome'])
                products.append(r)
            if not new:
                stale += 1
                if stale >= 2:
                    break
            else:
                stale = 0
            time.sleep(a.sleep)
        print(f'{c}: {len(products) - before} produtos')

    with open(a.out, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, delimiter=';',
                           fieldnames=['nome', 'sku', 'preco', 'url',
                                       'departamento', 'embalagem'])
        w.writeheader()
        w.writerows(products)
    print(f'\n{len(products)} produtos únicos → {a.out}')


if __name__ == '__main__':
    main()
