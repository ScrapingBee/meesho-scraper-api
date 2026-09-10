# Meesho Scraper API

<p align="center">
  <a href="https://www.scrapingbee.com/">
    <img src="REPLACE_WITH_SCREENSHOT_URL" alt="meesho-scraper-api" />
  </a>
</p>

[![checks](https://github.com/ScrapingBee/meesho-scraper-api/workflows/checks/badge.svg)](https://github.com/ScrapingBee/meesho-scraper-api/actions)
[![npm](https://img.shields.io/npm/v/meesho-scraper-api.svg)](https://www.npmjs.com/package/meesho-scraper-api)
[![node](https://img.shields.io/node/v/meesho-scraper-api.svg)](https://www.npmjs.com/package/meesho-scraper-api)
[![license](https://img.shields.io/github/license/ScrapingBee/meesho-scraper-api.svg)](LICENSE)

On Meesho, extraction is easy and discovery is the hard part. That is the opposite of most marketplaces, and it decides how you build. This is a [meesho scraper](https://www.scrapingbee.com/scrapers/meesho-scraper-api/) built on [ScrapingBee's web scraping API](https://www.scrapingbee.com/features/ai-web-scraping-api/), written in the order the problem actually presents itself: find the products, then read them.

Meesho is India's social commerce marketplace, and its catalogue is reseller driven, which shows up in the data model. The field most marketplaces call `brand` is the individual supplier here.

Every result below came from a live call on 2026-09-10.

## The discovery problem

Search does not work as a discovery route. This was tested twice, not assumed.

**Attempt one, cheap:** `https://www.meesho.com/search?q=kurti` through `mode=auto`. HTTP 200, 25 credits, and the page's own `__NEXT_DATA__` payload carried:

```json
{ "products": [], "productsCount": 0, "hasNextPage": true }
```

**Attempt two, with a browser:** the same URL with `render_js=true`, `premium_proxy=true` and `wait=8000`. HTTP 200, 25 credits, 155 KB of rendered HTML, and the same empty array. A scan of the rendered DOM found **zero links matching the `/p/` product path**.

Meesho fetches its listing grid from an internal endpoint after mount, and the results never land in the delivered payload or in the rendered markup within a reasonable wait. Paying for a browser here buys nothing. The `hasNextPage: true` flag is particularly misleading, because it reads like a working paginator sitting on an empty page.

## The sitemap is the index

Meesho publishes a full product sitemap, and that is the discovery route.

Fetching it directly does not work. A plain request returns an Akamai block:

```
HTTP 403
Access Denied
You don't have permission to access "http://www.meesho.com/sitemap.xml" on this server.
```

Through the API it returns fine:

```bash
curl -G "https://app.scrapingbee.com/api/v1/" \
  -H "Authorization: Bearer $SCRAPINGBEE_API_KEY" \
  --data-urlencode "url=https://www.meesho.com/sitemap.xml" \
  -d mode=auto
```

What comes back is a sitemap index of shards:

```xml
<sitemapindex>
  <sitemap><lastmod>2026-09-08</lastmod><loc>https://www.meesho.com/sitemap/pdp/7.xml</loc></sitemap>
  <sitemap><lastmod>2026-09-08</lastmod><loc>https://www.meesho.com/sitemap/pdp/492.xml</loc></sitemap>
  ...
</sitemapindex>
```

`pdp` is product detail page. Each shard lists real product URLs:

```
https://www.meesho.com/madhubani-print-saree/p/1nnri7
https://www.meesho.com/frc-decor-fridge-cover-combo-pack-multicolor/p/1jmqai
https://www.meesho.com/chuchumama-baby-diaper-pants-l-9-14-kg-pack-of-1-50-pieces-anti-lock-gel-technology-upto-12-hours-protection/p/1izwjr
```

The URL shape is `/<slug>/p/<id>`, where the id is a short base36 style code and is the same value that appears as `sku` and `mpn` in the product's structured data. `lastmod` on each shard is your change signal, so a daily crawl can skip shards that have not moved.

Do not invent these ids. Sitemap shards also list products that have since been delisted, and those answer **HTTP 410 GONE**, forwarded straight through because 410 is one of the few statuses ScrapingBee does not rewrite. The first URL in shard 0 was one of them. A crawl that raises on 410 dies partway through a shard of 7,044 URLs, so treat it as data.

Shard 0 held 7,044 product URLs, and the index listed 506 shards, so the public catalogue is on the order of three and a half million pages.

## Meesho blocks intermittently, and you pay for the blocks

This is the single most expensive thing to not know about this target.

Roughly two in five requests come back as an **Akamai bot challenge**, and ScrapingBee bills the full 75 credits for each one, because as far as the API is concerned the fetch succeeded. Measured on five consecutive calls to the same product URL, same parameters, no changes between them:

| Attempt | Status | Body | Cost | Result |
|---|---|---|---|---|
| 1 | 200 | 2,708 bytes | 75 | challenge |
| 2 | 200 | 293,588 bytes | 75 | full data |
| 3 | 200 | 155,158 bytes | 75 | full data |
| 4 | 200 | 293,602 bytes | 75 | full data |
| 5 | 200 | 2,708 bytes | 75 | challenge |
| 6 | 200 | 191,403 bytes | 75 | full data |
| 7 | 200 | 2,708 bytes | 75 | challenge |
| 8 | 200 | 22,917 bytes | 75 | full data |

Five returned data, three were challenged, 600 credits spent on eight fetches of one page.

The challenge is a **200**, not a 403. Its body is about 2,700 bytes, carries an Akamai sensor script and a `sec-if-cpt-container` element, and has no `<title>`, no structured data and no `__NEXT_DATA__`. Parse it without checking and every field reads as null while your code reports success.

Do not detect it on body size either. Successful responses in that run ranged from 22,917 bytes to 293,602, so any byte threshold you pick will misclassify one end or the other. Detect on content, using a marker a real response always carries:

```python
if "sec-if-cpt-container" in body or (
    "__NEXT_DATA__" not in body and "<loc>" not in body
):
    raise Blocked(url, len(body))
```

`__NEXT_DATA__` is present on every product and category page, `<loc>` on every sitemap, and neither appears in the challenge.

Then retry. Two or three attempts with a short backoff clears it in practice, but budget for it: at the measured 3 in 8 challenge rate, a product page costs about 120 credits on average rather than 75. That is a third off whatever throughput a per page estimate gives you.

## Reading a product page

Once you have a real URL, the page is generous. Two independent sources of the same data, which is useful because you can cross check them.

```python
import json, os, re

import requests

url = "https://www.meesho.com/madhubani-print-saree/p/1nnri7"
html = requests.get(
    "https://app.scrapingbee.com/api/v1/",
    headers={"Authorization": f"Bearer {os.environ['SCRAPINGBEE_API_KEY']}"},
    params={"url": url, "mode": "auto"},
    timeout=180,
).text

for block in re.findall(r'application/ld\+json[^>]*>(.*?)</script>', html, re.S):
    obj = json.loads(block)
    if obj.get("@type") == "Product":
        print(obj["name"], obj["sku"])
        print(obj["brand"]["name"], "is the supplier")
        print(obj["offers"]["price"], obj["offers"]["priceCurrency"], obj["offers"]["availability"])
```

### Source one: the Product structured data

```json
{
  "@type": "Product",
  "name": "MADHUBANI PRINT SAREE",
  "sku": "1nnri7",
  "mpn": "1nnri7",
  "brand": { "@type": "Thing", "name": "MS Shila pal" },
  "image": [
    "https://images.meesho.com/images/products/100206079/liprw_512.avif?width=512",
    "https://images.meesho.com/images/products/100206079/tpjfy_512.avif?width=512"
  ],
  "offers": {
    "@type": "Offer",
    "priceCurrency": "INR",
    "price": 420,
    "availability": "InStock",
    "url": "https://www.meesho.com/madhubani-print-saree/p/1nnri7"
  },
  "review": [ ... ]
}
```

Note the images are AVIF with a `?width=` parameter you can change, and that the numeric path segment (`100206079`) is an internal product id distinct from the `sku`.

### Source two: the application state

`props.pageProps.initialState.product.details.data` in the `__NEXT_DATA__` script tag carries fields the structured data does not:

| Field | Live value | Why it matters |
|---|---|---|
| `supplier_name` | `MS Shila pal` | Same as `brand.name` |
| `handle` | `MSShilapal` | The supplier's store handle, for supplier level crawls |
| `price` | `420` | Cross check against `offers.price` |
| `in_stock` | `true` | Boolean, easier than parsing the schema URL |
| `valid` | `true` | Meesho's own validity flag for the listing |
| `is_ad_product` | `false` | Whether the listing is a paid placement |
| `mall_verified` | `false` | Meesho Mall verification status |
| `description` | Structured text | Attribute lines such as `Saree Fabric: Cotton Silk` |
| `slug` | `madhubani-print-saree` | Reconstruct the canonical URL |

`is_ad_product` and `mall_verified` are the two worth building on. They are how you filter a scrape down to organic, verified listings rather than treating every row as equivalent.

The `description` field is not prose. It is newline separated attribute pairs, so it parses:

```python
attrs = dict(
    line.split(": ", 1)
    for line in data["description"].split("\n")
    if ": " in line
)
# {'Name': 'MADHUBANI PRINT SAREE', 'Saree Fabric': 'Cotton Silk', 'Blouse': 'Separate'}
```

### The category path

The `BreadcrumbList` block gives the full taxonomy with URLs at each level, five deep on the page tested:

```
Home > Women > Women Ethnic Wear > Sarees > MADHUBANI PRINT SAREE
```

Each level carries its own `/pl/<id>` listing URL, which is how you walk categories without touching search.

### What is not on the page

`initialState.product.reviews` came back with `loading: true` and `review_count: 0`, and `product.insights`, `product.pdpRatingReview` and `product.shipping` were all empty or null at capture. Review text and rating aggregates load from a separate endpoint after mount. The `review` array in the structured data does carry some entries, so use that rather than the application state if reviews matter.

## Ready made packages

```bash
pip install meesho-scraper-api
npm install meesho-scraper-api
```

```python
from meesho_scraper_api import MeeshoScraper, Blocked, ProductGone

bee = MeeshoScraper("YOUR_API_KEY")

shards = bee.sitemap_shards()                  # 506 shards, 75 credits
urls = bee.shard_products(shards[0]["loc"])    # 7,044 real product URLs
batch = bee.products(urls[:20])                # skips delisted rows
print(len(batch["items"]), "live,", len(batch["gone"]), "delisted")
```

`product()` retries the Akamai challenge automatically and raises `Blocked` only when every attempt is challenged. `products()` collects `ProductGone` into a `gone` list so one delisted row does not stop the batch.

## Credit cost

Meesho sits behind Akamai and every route that returns useful data lands on the stealth rung. Measured:

| Call | Credits | Outcome |
|---|---|---|
| `sitemap.xml` via `mode=auto` | 75 | Works, 506 shards |
| A `pdp` shard via `mode=auto` | 75 | Works, 7,044 URLs in shard 0 |
| Product page via `mode=auto` | 75 | Full data, about 3 times in 5 |
| The same page, challenged | 75 | Billed anyway, see above |
| Delisted product | 0 | HTTP 410, nothing billed |
| Search page via `mode=auto` | 25 | 200 status, zero products |
| Search page with `render_js` and `premium_proxy` | 25 | 200 status, still zero products |

The two cheapest calls in that table are the two that do not work, which is the whole argument for the sitemap route. `mode=auto` charges only for the rung that succeeded and nothing at all if every rung fails, so it is the right default even when the answer is 75.

Practical budgeting: at 75 credits nominal and about 125 credits effective once retries are counted, the entry paid tier of 250,000 credits covers roughly 2,000 products a month rather than 3,300. Use `lastmod` on the shards to avoid refetching unchanged pages, because ScrapingBee does not cache and every repeat costs full price. Plan tiers are on the [pricing page](https://www.scrapingbee.com/pricing).

## Scope

Public catalogue, product and category pages. Supplier dashboards, buyer accounts, order data and anything behind a sign in are out of scope, and scraping under login credentials is prohibited by ScrapingBee's terms of service. Meesho's own Terms and Conditions and Privacy Policy govern use of the data, under `meesho.com/legal/`. Worth noting that those pages are client side rendered on a catch all `/legal/[legalType]` route, so a fabricated slug under that path returns the same 200 shell as a real one. Read them in a browser rather than asserting a URL. Supplier names in the catalogue belong to individual sellers rather than to companies, so treat them as personal data where that applies.

Reference: [extraction rules](https://www.scrapingbee.com/documentation/data-extraction/) for the selector syntax, and [markdown output](https://www.scrapingbee.com/features/markdown-scraper/) if you are feeding catalogue pages to a model. The two standards this project leans on are the [sitemap protocol](https://www.sitemaps.org/protocol.html), which defines the sitemap index and `lastmod` semantics used for discovery, and [schema.org Product](https://schema.org/Product), which defines every field read out of the structured data block.

## FAQ

**Does Meesho have a public API?**
Not for catalogue browsing. Meesho publishes supplier facing APIs for its own sellers. Public product data has to come off the pages, which is what this project covers.

**Why is every field null even though the request succeeded?**
Because Meesho served an Akamai challenge with a 200 status. Check for `sec-if-cpt-container` in the body, or for a body under about 5 KB with no `__NEXT_DATA__`, and retry. It happened on 2 of 5 consecutive calls in testing.

**Why do some sitemap URLs fail?**
They are delisted products and answer HTTP 410, which ScrapingBee forwards rather than rewriting. Nothing is billed for those. Skip them and continue.

**Why does my Meesho search scrape return no products?**
Because the listing grid never lands in the payload or the rendered DOM. Both a cheap fetch and a full browser render were tested and both returned an empty `products` array. Use the sitemap shards for discovery instead.

**Which currency are prices in?**
INR, stated explicitly as `offers.priceCurrency`. Prices are plain integers, not strings, so no parsing needed.

**Where is the brand name?**
There generally is not one. `brand.name` holds the individual supplier, because Meesho is a reseller marketplace. Cross check it against `supplier_name` and use `handle` to crawl that supplier's other listings.

**How do I skip sponsored listings?**
Filter on `is_ad_product` from the application state. It is not exposed in the structured data.

## Credits

Built and maintained by [wordstotech](https://github.com/wordstotech-design). Powered by ScrapingBee.

## License

MIT. See [LICENSE](LICENSE).
