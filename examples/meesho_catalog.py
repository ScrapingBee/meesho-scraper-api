"""Meesho catalogue scraping: sitemap discovery, then product extraction.

Verified live on 2026-09-10. Meesho sits behind Akamai, so every route
that returns useful data lands on the stealth rung at 75 credits.
Search is NOT a usable discovery route: the listing grid never reaches
the payload or the rendered DOM. Use the sitemap shards.
Set SCRAPINGBEE_API_KEY in your environment before running.
"""

import json
import os
import re
import time

import requests

BASE = "https://app.scrapingbee.com/api/v1/"
HEADERS = {"Authorization": f"Bearer {os.environ['SCRAPINGBEE_API_KEY']}"}


class Blocked(RuntimeError):
    """Meesho served an Akamai bot challenge instead of the page.

    Arrives as HTTP 200 with about 2,700 bytes, an Akamai sensor script
    and a sec-if-cpt-container element, no title and no __NEXT_DATA__.
    ScrapingBee bills the full 75 credits for it. Measured on five
    consecutive calls to one URL: attempts 1 and 5 challenged, 2, 3 and 4
    returned full data. Retry.
    """


class ProductGone(LookupError):
    """Sitemap shards list delisted products, which answer 404 or 410."""


def _fetch_once(url):
    """mode=auto charges only for the rung that succeeded, and nothing if
    every rung fails. On Meesho that rung is stealth, so expect 75."""
    r = requests.get(
        BASE, headers=HEADERS, params={"url": url, "mode": "auto"}, timeout=180
    )
    # ScrapingBee forwards 404, 410 and 413 rather than rewriting them.
    if r.status_code in (404, 410):
        raise ProductGone(f"{url} (HTTP {r.status_code})")
    r.raise_for_status()

    body = r.text
    # Detect the challenge on CONTENT, never on status. A 200 with a
    # challenge inside makes every field read as None while your code
    # reports success.
    if "sec-if-cpt-container" in body or (
        "__NEXT_DATA__" not in body and "<loc>" not in body
    ):
        raise Blocked(f"{url} returned an Akamai challenge ({len(body)} bytes)")
    return body


def _fetch(url, retries=3):
    """Retry the challenge. Every attempt costs 75 credits, blocked ones
    included, so keep retries low and cache what succeeds."""
    last = None
    for attempt in range(retries):
        try:
            return _fetch_once(url)
        except Blocked as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(2 * (attempt + 1))
    raise last


def sitemap_shards():
    """The sitemap index. A direct request returns an Akamai 403."""
    xml = _fetch("https://www.meesho.com/sitemap.xml")
    shards = []
    for block in re.findall(r"<sitemap>(.*?)</sitemap>", xml, re.S):
        loc = re.search(r"<loc>(.*?)</loc>", block)
        mod = re.search(r"<lastmod>(.*?)</lastmod>", block)
        if loc:
            shards.append({"loc": loc.group(1), "lastmod": mod.group(1) if mod else None})
    return shards


def shard_products(shard_url):
    """Real product URLs from one pdp shard. Never construct these yourself:
    an invented id returns a 200 with a nearly empty body."""
    xml = _fetch(shard_url)
    return re.findall(r"<loc>(https://www\.meesho\.com/[^<]*?/p/[^<]+)</loc>", xml)


def _jsonld(html):
    for block in re.findall(
        r"application/ld\+json[^>]*>(.*?)</script>", html, re.S
    ):
        try:
            yield json.loads(block)
        except json.JSONDecodeError:
            continue


def _next_data(html):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    return json.loads(m.group(1)) if m else {}


def product(url):
    """Merge both sources of product data on a Meesho product page.

    Structured data gives images, sku and the offer. The application state
    gives is_ad_product, mall_verified and the supplier handle, which the
    structured data does not carry.
    """
    html = _fetch(url)
    out = {"url": url}

    for obj in _jsonld(html):
        if not isinstance(obj, dict):
            continue
        if obj.get("@type") == "Product":
            offers = obj.get("offers") or {}
            out.update(
                name=obj.get("name"),
                sku=obj.get("sku"),
                images=obj.get("image") or [],
                # brand.name is the individual supplier: Meesho is a
                # reseller marketplace, so there is usually no real brand.
                supplier=(obj.get("brand") or {}).get("name"),
                price=offers.get("price"),
                currency=offers.get("priceCurrency"),
                availability=offers.get("availability"),
                reviews=obj.get("review") or [],
            )
        elif obj.get("@type") == "BreadcrumbList":
            out["category_path"] = [
                {"name": i.get("name"), "url": i.get("item")}
                for i in obj.get("itemListElement", [])
            ]

    data = (
        _next_data(html)
        .get("props", {})
        .get("pageProps", {})
        .get("initialState", {})
        .get("product", {})
        .get("details", {})
        .get("data")
        or {}
    )
    out.update(
        handle=data.get("handle"),
        slug=data.get("slug"),
        in_stock=data.get("in_stock"),
        valid=data.get("valid"),
        is_ad_product=data.get("is_ad_product"),
        mall_verified=data.get("mall_verified"),
        state_price=data.get("price"),
    )

    # The description field is newline separated attribute pairs, not prose.
    if data.get("description"):
        out["attributes"] = dict(
            line.split(": ", 1)
            for line in data["description"].split("\n")
            if ": " in line
        )
    return out


def products(urls):
    """Scrape many URLs, separating live rows from delisted ones."""
    items, gone = [], []
    for url in urls:
        try:
            items.append(product(url))
        except ProductGone:
            gone.append(url)
    return {"items": items, "gone": gone}


if __name__ == "__main__":
    shards = sitemap_shards()
    print(f"{len(shards)} sitemap shards, newest lastmod {shards[0]['lastmod']}")

    urls = shard_products(shards[0]["loc"])
    print(f"{len(urls)} product URLs in shard 0")

    # urls[0] on shard 0 is a delisted product and answers 410, so run a
    # small batch rather than assuming the first URL is live.
    batch = products(urls[:5])
    print(f"{len(batch['items'])} live, {len(batch['gone'])} delisted")
    if not batch["items"]:
        raise SystemExit("no live products in this slice")

    item = batch["items"][0]
    print(f"{item['name']}  {item['price']} {item['currency']}")
    print(f"  supplier {item['supplier']} ({item['handle']})")
    print(f"  ad={item['is_ad_product']}  mall_verified={item['mall_verified']}")
    print(f"  {' > '.join(c['name'] for c in item.get('category_path', []))}")
