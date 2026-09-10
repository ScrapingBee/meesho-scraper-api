// Meesho catalogue scraping: sitemap discovery, then product extraction.
// Verified live on 2026-09-10. Meesho sits behind Akamai, so every route
// that returns useful data lands on the stealth rung at 75 credits.
// Search is NOT a usable discovery route: the listing grid never reaches
// the payload or the rendered DOM. Use the sitemap shards.

const axios = require('axios');

const BASE = 'https://app.scrapingbee.com/api/v1/';
const headers = { Authorization: `Bearer ${process.env.SCRAPINGBEE_API_KEY}` };

// Meesho served an Akamai bot challenge instead of the page. Arrives as
// HTTP 200 with an Akamai sensor script and a sec-if-cpt-container
// element, no title and no __NEXT_DATA__. ScrapingBee bills the full 75
// credits for it. Measured over eight consecutive calls to one URL:
// 5 returned data, 3 were challenged, 600 credits spent. Retry.
class Blocked extends Error {}

// Sitemap shards list delisted products, which answer 404 or 410.
class ProductGone extends Error {}

// mode=auto charges only for the rung that succeeded, and nothing at all
// if every rung fails. On Meesho that rung is stealth, so expect 75 per
// attempt, blocked attempts included.
async function fetchOnce(url) {
  const res = await axios.get(BASE, {
    headers,
    params: { url, mode: 'auto' },
    timeout: 180000,
    // ScrapingBee forwards 404, 410 and 413 rather than rewriting them.
    validateStatus: (s) => (s >= 200 && s < 300) || [404, 410].includes(s),
    responseType: 'text',
    transformResponse: [(d) => d],
  });

  if (res.status === 404 || res.status === 410) {
    throw new ProductGone(`${url} (HTTP ${res.status})`);
  }

  const body = String(res.data);
  // Detect the challenge on CONTENT, never on status or body size. One
  // captured challenge was 2,708 bytes and another response was 22,917,
  // so a byte threshold misclassifies. A real page always carries either
  // __NEXT_DATA__ (a page) or <loc> (a sitemap).
  if (
    body.includes('sec-if-cpt-container') ||
    (!body.includes('__NEXT_DATA__') && !body.includes('<loc>'))
  ) {
    throw new Blocked(`${url} returned an Akamai challenge (${body.length} bytes)`);
  }
  return body;
}

// Retry the challenge. Every attempt costs 75 credits, blocked ones
// included, so keep retries low and cache what succeeds.
async function fetchUrl(url, retries = 3) {
  let last = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      if (!(err instanceof Blocked)) throw err;
      last = err;
      if (attempt + 1 < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw last;
}

// The sitemap index. A direct request returns an Akamai 403.
// Use lastmod as the change signal so a daily crawl can skip shards that
// have not moved: ScrapingBee does not cache and every repeat costs full.
async function sitemapShards() {
  const xml = await fetchUrl('https://www.meesho.com/sitemap.xml');
  const blocks = xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) || [];
  return blocks
    .map((b) => ({
      loc: (b.match(/<loc>(.*?)<\/loc>/) || [])[1],
      lastmod: (b.match(/<lastmod>(.*?)<\/lastmod>/) || [])[1] || null,
    }))
    .filter((s) => s.loc);
}

// Real product URLs from one pdp shard. Never construct these yourself.
// Shard 0 held 7,044 URLs and the index listed 506 shards.
async function shardProducts(shardUrl) {
  const xml = await fetchUrl(shardUrl);
  const matches = xml.match(/<loc>https:\/\/www\.meesho\.com\/[^<]*?\/p\/[^<]+<\/loc>/g) || [];
  return matches.map((m) => m.replace(/<\/?loc>/g, ''));
}

function jsonLdBlocks(html) {
  const out = [];
  const blocks = html.match(/application\/ld\+json[^>]*>[\s\S]*?<\/script>/g) || [];
  for (const block of blocks) {
    const body = block.replace(/^application\/ld\+json[^>]*>/, '').replace(/<\/script>$/, '');
    try {
      out.push(JSON.parse(body));
    } catch {
      // skip unparsable blocks
    }
  }
  return out;
}

// props.pageProps.initialState.product.details.data, or an empty object.
// Reviews are NOT here: product.reviews came back loading with
// review_count 0, and insights, pdpRatingReview and shipping were all
// empty at capture. Use the review array in the structured data instead.
function stateData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return {};
  try {
    const payload = JSON.parse(m[1]);
    return (
      ((((payload.props || {}).pageProps || {}).initialState || {}).product || {}).details
        ?.data || {}
    );
  } catch {
    return {};
  }
}

// Merge both sources. Structured data gives images, sku and the offer.
// The application state gives is_ad_product, mall_verified and the
// supplier handle, which the structured data does not carry.
async function product(url) {
  const html = await fetchUrl(url);
  const out = { url };

  for (const obj of jsonLdBlocks(html)) {
    if (!obj || typeof obj !== 'object') continue;
    if (obj['@type'] === 'Product') {
      const offers = obj.offers || {};
      Object.assign(out, {
        name: obj.name,
        sku: obj.sku,
        images: obj.image || [],
        // brand.name is the individual supplier: Meesho is a reseller
        // marketplace, so there is usually no real brand.
        supplier: (obj.brand || {}).name,
        price: offers.price,
        currency: offers.priceCurrency,
        availability: offers.availability,
        reviews: obj.review || [],
      });
    } else if (obj['@type'] === 'BreadcrumbList') {
      out.category_path = (obj.itemListElement || []).map((i) => ({
        name: i.name,
        url: i.item,
      }));
    }
  }

  const data = stateData(html);
  Object.assign(out, {
    handle: data.handle,
    slug: data.slug,
    in_stock: data.in_stock,
    valid: data.valid,
    is_ad_product: data.is_ad_product,
    mall_verified: data.mall_verified,
    state_price: data.price,
  });

  // The description field is newline separated attribute pairs, not prose.
  if (data.description) {
    out.attributes = {};
    for (const line of data.description.split('\n')) {
      const idx = line.indexOf(': ');
      if (idx > 0) out.attributes[line.slice(0, idx)] = line.slice(idx + 2);
    }
  }
  return out;
}

// Scrape many URLs, separating live rows from delisted ones.
async function products(urls) {
  const items = [];
  const gone = [];
  for (const url of urls) {
    try {
      items.push(await product(url));
    } catch (err) {
      if (err instanceof ProductGone) gone.push(url);
      else throw err;
    }
  }
  return { items, gone };
}

(async () => {
  const shards = await sitemapShards();
  console.log(`${shards.length} sitemap shards, newest lastmod ${shards[0].lastmod}`);

  const urls = await shardProducts(shards[0].loc);
  console.log(`${urls.length} product URLs in shard 0`);

  // urls[0] on shard 0 is a delisted product and answers 410, so run a
  // small batch rather than assuming the first URL is live.
  const batch = await products(urls.slice(0, 5));
  console.log(`${batch.items.length} live, ${batch.gone.length} delisted`);
  if (!batch.items.length) return;

  const item = batch.items[0];
  console.log(`${item.name}  ${item.price} ${item.currency}`);
  console.log(`  supplier ${item.supplier} (${item.handle})`);
  console.log(`  ad=${item.is_ad_product}  mall_verified=${item.mall_verified}`);
})();

module.exports = { sitemapShards, shardProducts, product, products, Blocked, ProductGone };
