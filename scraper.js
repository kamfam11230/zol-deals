/**
 * Zol Deals — Daily Amazon Affiliate Deals Automation
 * =====================================================
 * Runs with Node.js (no Python needed).
 *
 * What it does on every run:
 *   1. Scrapes tjbdeals.com for all Amazon deals
 *   2. Skips deals already processed today (uses cache — no extra AI cost)
 *   3. Rewrites only NEW deals using Claude AI
 *   4. Regenerates the static HTML website with all deals
 *   5. Pushes to GitHub only if new deals were found (Netlify auto-deploys)
 *   6. Saves a WhatsApp broadcast .txt to your Desktop
 *
 * Run manually:  node scraper.js
 * Scheduled:     Windows Task Scheduler — runs every 30 minutes
 */

const axios      = require('axios');       // fetches web pages
const cheerio    = require('cheerio');     // parses HTML
const Groq = require('groq-sdk'); // Groq AI (free, fast, global)
const fs         = require('fs');          // file system (built-in)
const path       = require('path');        // file paths (built-in)
const https      = require('https');       // for resolving short links (built-in)
const { execSync } = require('child_process'); // runs git commands (built-in)

// ══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════════

const AFFILIATE_TAG = 'gowns04-20';
const SOURCE_URL    = 'https://www.tjbdeals.com';
const SITE_DIR      = 'zol-deals-site';
const DEALS_DIR     = path.join(SITE_DIR, 'deals');
const ARCHIVE_FILE  = 'archive.json';
const DESKTOP_PATH  = 'C:\\Users\\it\\OneDrive - Element Re Development\\Desktop';

// Detect if we're running on GitHub Actions (cloud) vs your local PC
// When true: skips the Windows Desktop file save and internal git push
//            (the GitHub Actions workflow handles committing instead)
const IS_CI = process.env.GITHUB_ACTIONS === 'true';

// Daily cache — stores processed deals so we never re-call the AI for the same deal
// File is named deals_cache_YYYY-MM-DD.json and resets automatically each new day
function cacheFile(dateStr) { return `deals_cache_${dateStr}.json`; }

function loadCache(dateStr) {
  const file = cacheFile(dateStr);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')); // array of enriched deals
  }
  return [];
}

function saveCache(dateStr, deals) {
  fs.writeFileSync(cacheFile(dateStr), JSON.stringify(deals, null, 2));
}

// Realistic browser header so we don't get blocked
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36',
};

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

/** Pause for a given number of milliseconds (polite scraping) */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Escape HTML special characters so text doesn't break the page */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Today's date as YYYY-MM-DD */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Format a YYYY-MM-DD string as "March 06, 2026" */
function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon avoids timezone edge cases
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });
}

// ══════════════════════════════════════════════════════════════════
//  IMAGE HELPERS
// ══════════════════════════════════════════════════════════════════

/**
 * Returns true if this image URL is a known bad/screenshot image.
 * Defined at module level so it works both at scrape time AND at
 * HTML-render time (catching stale bad URLs already in the cache).
 */
function isBadImage(u) {
  if (!u) return true;
  // UUID filenames, incl. WordPress -e[timestamp] suffix
  if (/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-e\d+)?\./i.test(u)) return true;
  // Files literally named "Untitled" (checkout screenshots)
  if (/\/untitled\./i.test(u)) return true;
  // Screenshot filenames (Screenshot-2026-03-04-at-10.15.37-PM.png etc.)
  if (/\/screenshot[-_.]/i.test(u)) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════
//  AFFILIATE LINK HELPERS
// ══════════════════════════════════════════════════════════════════

/**
 * Returns true only for Amazon product pages or amzn.to short links.
 * Deliberately excludes Prime signup pages, Amazon Business, wishlist links,
 * "Don't miss a deal" posts, etc. — only real product URLs count.
 */
function isAmazonLink(url) {
  if (url.includes('amzn.to')) return true;
  if (url.includes('amazon.com/dp/') || url.includes('amazon.com/gp/product/')) return true;
  return false;
}

/** Add our affiliate tag to an Amazon link */
function tagLink(url) {
  if (url.includes('amzn.to')) {
    // Short link — just append the tag
    return url.includes('?')
      ? `${url}&tag=${AFFILIATE_TAG}`
      : `${url}?tag=${AFFILIATE_TAG}`;
  }
  if (url.includes('amazon.com')) {
    // Full URL — replace or add the tag parameter
    const u = new URL(url);
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  }
  return url;
}

/** Extract a 10-char Amazon ASIN from a full amazon.com URL */
function extractAsin(url) {
  const m = (url || '').match(/\/(?:dp|gp\/product|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Follow an amzn.to short link one hop and return the full amazon.com URL.
 * amzn.to links have the ORIGINAL creator's tag baked in — we must resolve
 * the redirect first to get the real amazon.com URL, then swap the tag.
 * Falls back to the original short URL if anything goes wrong.
 */
function resolveAmznShortLink(shortUrl) {
  return new Promise((resolve) => {
    try {
      const req = https.get(shortUrl, { headers: HEADERS }, (res) => {
        const location = res.headers.location;
        res.destroy(); // don't download the body
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          // If it redirected to another short link, keep the original
          // (tagLink will append tag= which Amazon honours on one-hop chains)
          resolve(location.includes('amazon.com') ? location : shortUrl);
        } else {
          resolve(shortUrl);
        }
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(shortUrl); });
      req.on('error', () => resolve(shortUrl));
    } catch (e) {
      resolve(shortUrl);
    }
  });
}

/**
 * Fetch the Amazon product page for a given ASIN and extract the main
 * product image URL. Amazon embeds image data in JSON objects in the page
 * source — we pull the hiRes or large URL from there without executing JS.
 * Returns null on any failure so callers can fall back gracefully.
 */
async function fetchAmazonProductImage(asin) {
  try {
    const resp = await axios.get(`https://www.amazon.com/dp/${asin}`, {
      headers: HEADERS,
      timeout: 10000,
    });
    const html = resp.data;
    // Amazon embeds image data in several places; try each in order of preference
    const m = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/)
           || html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/)
           || html.match(/"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/)
           || html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════
//  SCRAPING
// ══════════════════════════════════════════════════════════════════

/** Fetch the homepage and return all post links */
async function getPostLinks() {
  console.log('Fetching tjbdeals.com homepage...');
  try {
    const resp = await axios.get(SOURCE_URL, { headers: HEADERS, timeout: 15000 });
    const $    = cheerio.load(resp.data);
    const links = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.startsWith('http')) return;
      if (!href.includes('tjbdeals.com')) return;
      // WordPress post ID links (?p=XXXXX) or slug-style post links
      if (href.includes('?p=') || href.split('/').length >= 5) {
        links.add(href);
      }
    });

    console.log(`  Found ${links.size} post links.\n`);
    return [...links];
  } catch (err) {
    console.log(`  ERROR fetching homepage: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single post page and extract deal info.
 * Returns an object, or null if there's no Amazon link.
 */
async function scrapePost(url) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $    = cheerio.load(resp.data);

    // Collect all Amazon links on this page
    const amazonLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (isAmazonLink(href)) amazonLinks.push(href);
    });

    if (amazonLinks.length === 0) {
      console.log(`  No Amazon links — skipping: ${url}`);
      return null;
    }

    // Extract title
    const title =
      $('h1.entry-title').text().trim() ||
      $('h1.post-title').text().trim()  ||
      $('h1').first().text().trim()     ||
      'Amazon Deal';

    // Extract description (first few paragraphs of post body)
    const contentEl =
      $('.entry-content').first() ||
      $('.post-content').first()  ||
      $('article').first();

    const paragraphs = [];
    contentEl.find('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) paragraphs.push(t);
    });
    const description = paragraphs.slice(0, 3).join(' ').slice(0, 800) || title;

    // Extract promo code — look in <strong> tags first, then full content text
    let promoCode = null;
    contentEl.find('strong').each((_, el) => {
      if (promoCode) return;
      const t = $(el).text().trim();
      const m = t.match(/(?:promo|coupon|discount)\s*code[:\s]+([A-Z0-9]{4,20})/i)
             || t.match(/use\s+(?:code|coupon)[:\s]+([A-Z0-9]{4,20})/i);
      if (m) promoCode = m[1].toUpperCase();
    });
    if (!promoCode) {
      const fullText = contentEl.text();
      const m = fullText.match(/(?:promo|coupon|discount)\s*code[:\s]+([A-Z0-9]{4,20})/i)
             || fullText.match(/use\s+(?:code|coupon)[:\s]+([A-Z0-9]{4,20})/i);
      if (m) promoCode = m[1].toUpperCase();
    }

    // Extract product image — prefer Amazon CDN images; skip known bad/screenshot filenames
    let imageUrl = null;
    // 1st choice: Amazon-hosted product image anywhere in the post body
    contentEl.find('img').each((_, el) => {
      if (imageUrl) return;
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src.includes('m.media-amazon.com') || src.includes('ssl-images-amazon.com')) {
        imageUrl = src;
      }
    });
    // 2nd choice: og:image / og:image:secure_url (skip bad images)
    if (!imageUrl) {
      const ogImg = $('meta[property="og:image"]').attr('content')
                 || $('meta[property="og:image:secure_url"]').attr('content')
                 || $('meta[name="og:image"]').attr('content')
                 || null;
      if (ogImg && !isBadImage(ogImg)) imageUrl = ogImg;
    }
    // 3rd choice: first non-bad image anywhere in the content (incl. TJBDeals CDN)
    if (!imageUrl) {
      contentEl.find('img').each((_, el) => {
        if (imageUrl) return;
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src && !isBadImage(src)) imageUrl = src;
      });
    }

    // 4th choice: scrape the Amazon product page for the main product image.
    // Only runs when we still have no image — keeps cached runs instant.
    if (!imageUrl && amazonLinks.length > 0) {
      const asinCandidate = extractAsin(amazonLinks[0]) || extractAsin(await resolveAmznShortLink(amazonLinks[0]));
      if (asinCandidate) {
        const amzImg = await fetchAmazonProductImage(asinCandidate);
        if (amzImg) imageUrl = amzImg;
        await sleep(1000); // polite pause after hitting Amazon
      }
    }

    // Resolve amzn.to short links → full amazon.com URL → then swap tag
    // (tag= appended to a short link doesn't override the baked-in tag)
    let rawLink = amazonLinks[0];
    if (rawLink.includes('amzn.to')) {
      rawLink = await resolveAmznShortLink(rawLink);
    }

    const affiliateUrl = tagLink(rawLink);
    return {
      title,
      description,
      imageUrl,
      promoCode,
      asin: extractAsin(affiliateUrl),
      affiliateUrl,
      sourceUrl: url,
    };
  } catch (err) {
    console.log(`  Skipping (load error): ${url} — ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  AI REWRITING
// ══════════════════════════════════════════════════════════════════

/**
 * Ask Groq (Llama) to produce a website version and a WhatsApp version.
 * Falls back to original text if the API call fails.
 */
async function rewriteDeal(groq, title, description, promoCode = null) {
  const promoLine = promoCode ? `\nPROMO CODE: ${promoCode} — work this code into the copy naturally.` : '';
  const prompt = `You are a copywriter for Zol Deals, an Amazon deals site.

Rewrite this deal in TWO versions:

DEAL TITLE: ${title}
DEAL DESCRIPTION: ${description}${promoLine}

VERSION 1 - WEBSITE
2-3 punchy sentences. Highlights the value or savings. Ends with "Grab it here →".
Plain prose only — no markdown, no bullet points, no asterisks.

VERSION 2 - WHATSAPP
1-2 casual sentences. Include 1-2 relevant emojis. Under 50 words total.
Feels like a tip from a friend.

Reply in this EXACT format (nothing before or after):
WEBSITE: [your website copy here]
WHATSAPP: [your whatsapp copy here]`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      max_tokens: 300,
    });
    const text = completion.choices[0]?.message?.content?.trim();

    const webMatch = text.match(/WEBSITE:\s*([\s\S]+?)(?=WHATSAPP:|$)/);
    const waMatch  = text.match(/WHATSAPP:\s*([\s\S]+?)$/);

    const webCopy = webMatch ? webMatch[1].trim() : null;
    const waCopy  = waMatch  ? waMatch[1].trim()  : null;

    if (webCopy && waCopy) return { webCopy, waCopy };
  } catch (err) {
    console.log(`  AI rewrite failed (${err.message}) — using fallback.`);
  }

  // Fallback: trim original text
  return {
    webCopy: `${description.slice(0, 200).trimEnd()} Grab it here →`,
    waCopy:  'Hot deal on Amazon today! 🛒 Worth checking out.',
  };
}

// ══════════════════════════════════════════════════════════════════
//  CSS  (shared by all pages)
// ══════════════════════════════════════════════════════════════════

const SITE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f5f5;
  color: #333;
  line-height: 1.6;
}

header {
  background: #232f3e;
  color: #fff;
  padding: 24px 16px;
  text-align: center;
}
header h1 { font-size: 2.2rem; color: #FF9900; letter-spacing: -0.5px; }
header p.tagline { font-size: 1rem; color: #b0b8c1; margin-top: 4px; }

.container { max-width: 960px; margin: 0 auto; padding: 28px 16px; }

h2.section-title {
  font-size: 1.4rem;
  color: #232f3e;
  border-bottom: 3px solid #FF9900;
  padding-bottom: 8px;
  margin-bottom: 20px;
}

.deals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  margin-bottom: 48px;
}

.deal-card {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: box-shadow 0.2s;
}
.deal-card:hover { box-shadow: 0 4px 18px rgba(0,0,0,0.14); }
.deal-card h3 { font-size: 1rem; color: #111; line-height: 1.45; }
.deal-card p  { font-size: 0.93rem; color: #555; flex-grow: 1; }

.deal-img {
  width: 100%;
  height: 180px;
  overflow: hidden;
  border-radius: 6px;
  background: #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.deal-img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 8px;
}

.btn {
  display: inline-block;
  background: #FF9900;
  color: #fff;
  text-decoration: none;
  padding: 10px 18px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 0.9rem;
  text-align: center;
  transition: background 0.15s;
}
.btn:hover { background: #e68a00; }

.no-deals {
  text-align: center;
  color: #999;
  padding: 48px 20px;
  font-size: 1.1rem;
  background: #fff;
  border-radius: 10px;
  margin-bottom: 48px;
}

.archive-list {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 48px;
}
.archive-list a {
  display: inline-block;
  background: #fff;
  border: 2px solid #FF9900;
  color: #232f3e;
  text-decoration: none;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 0.88rem;
  font-weight: 600;
  transition: all 0.15s;
}
.archive-list a:hover { background: #FF9900; color: #fff; }

.promo-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fff8e7;
  border: 1.5px dashed #FF9900;
  border-radius: 6px;
  padding: 7px 12px;
}
.promo-label {
  font-size: 0.75rem;
  font-weight: 700;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.promo-copy {
  font-family: 'Courier New', monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: #232f3e;
  letter-spacing: 1.5px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 0.15s;
  flex: 1;
  text-align: left;
}
.promo-copy:hover { background: rgba(255,153,0,0.15); }

.back-link {
  display: inline-block;
  color: #FF9900;
  text-decoration: none;
  font-weight: 600;
  margin-bottom: 20px;
  font-size: 0.95rem;
}
.back-link:hover { text-decoration: underline; }

footer {
  background: #232f3e;
  color: #8a97a5;
  text-align: center;
  padding: 20px 16px;
  font-size: 0.82rem;
}

@media (max-width: 600px) {
  .deals-grid { grid-template-columns: 1fr; }
  header h1   { font-size: 1.6rem; }
}
`.trim();

// ══════════════════════════════════════════════════════════════════
//  DEEP-LINK JS  (opens Amazon app on mobile, falls back to web)
// ══════════════════════════════════════════════════════════════════

// Inlined into every page so no extra round-trip is needed.
//
// iOS Safari:  window.location.href = amazon URL  →  iOS Universal Links intercepts
//              and opens the Amazon app if installed; otherwise loads in Safari.
//              (amzn:// scheme was dropped: if the app isn't installed Safari shows
//               a dead-end error, and the setTimeout/window.open fallback is then
//               blocked as an unsolicited popup — leaving the link completely dead.)
//
// Android:     intent:// URI explicitly routes to the Amazon app.
//              The browser_fallback_url field handles "app not installed" gracefully.
//
// Desktop:     window.open in a new tab, unchanged.
const SITE_JS = `
function openDeal(evt, el) {
  var url = el.href;
  var asin = el.dataset.asin;
  var ua = navigator.userAgent;

  // iOS: return WITHOUT calling preventDefault so the native <a> tap proceeds.
  // iOS intercepts amazon.com Universal Links BEFORE the browser navigates —
  // but ONLY if the tap event hasn't been cancelled. Calling preventDefault()
  // here kills the event and the app never opens.
  if (/iPhone|iPad|iPod/i.test(ua)) return;

  // Everything else needs preventDefault so we can control the navigation.
  evt.preventDefault();

  // Desktop: open Amazon in a new tab as normal
  if (!/Mobi|Android/i.test(ua)) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  // Android + ASIN: intent URI routes directly to the Amazon app.
  // browser_fallback_url handles "app not installed" gracefully.
  if (asin) {
    window.location.href =
      'intent://www.amazon.com/dp/' + asin + '?tag=${AFFILIATE_TAG}' +
      '#Intent;scheme=https;package=com.amazon.mShop.android.shopping;' +
      'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    return;
  }

  // Android without an extractable ASIN: fall back to plain navigation
  window.location.href = url;
}
`.trim();

// ══════════════════════════════════════════════════════════════════
//  HTML GENERATION
// ══════════════════════════════════════════════════════════════════

function cardHtml(deal) {
  // Use the scraped image (if it passes the bad-image filter), then fall back to
  // Amazon's predictable ASIN image CDN URL. This also catches stale bad URLs
  // that were cached before the isScreenshot logic was in place.
  // The onerror hides the container silently if the CDN URL resolves to a 404.
  const goodImg = !isBadImage(deal.imageUrl) ? deal.imageUrl : null;
  const imgSrc = goodImg
    || (deal.asin ? `https://images-na.ssl-images-amazon.com/images/P/${deal.asin}.01.L.jpg` : null);
  const imgHtml = imgSrc
    ? `<div class="deal-img"><img src="${imgSrc}" alt="${esc(deal.title)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  const promoHtml = deal.promoCode
    ? `      <div class="promo-badge">
        <span class="promo-label">Code</span>
        <button class="promo-copy" onclick="this.textContent='Copied!';navigator.clipboard.writeText('${esc(deal.promoCode)}');setTimeout(()=>this.textContent='${esc(deal.promoCode)}',1500)">${esc(deal.promoCode)}</button>
      </div>`
    : '';
  const asinAttr = deal.asin ? ` data-asin="${esc(deal.asin)}"` : '';
  return `    <div class="deal-card">
${imgHtml}
      <h3>${esc(deal.title)}</h3>
      <p>${esc(deal.webCopy)}</p>
${promoHtml}
      <a class="btn" href="${deal.affiliateUrl}"${asinAttr} target="_blank" rel="noopener sponsored" onclick="openDeal(event,this)">Shop on Amazon →</a>
    </div>`;
}

function generateIndex(deals, archiveDates) {
  const today     = todayStr();
  const todayDisp = prettyDate(today);

  const dealsSection = deals.length
    ? `  <div class="deals-grid">\n${deals.map(cardHtml).join('\n')}\n  </div>`
    : '  <p class="no-deals">No Amazon deals found today. Check back tomorrow!</p>';

  const pastDates = archiveDates
    .filter(d => d !== today)
    .sort()
    .reverse()
    .slice(0, 30);

  const archiveSection = pastDates.length
    ? `    <h2 class="section-title">Past Deals</h2>
    <ul class="archive-list">
${pastDates.map(d =>
  `      <li><a href="deals/${d}.html">${prettyDate(d)}</a></li>`
).join('\n')}
    </ul>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zol Deals — Best Amazon Deals Today</title>
  <meta name="description" content="The best Amazon deals, curated daily.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Zol Deals</h1>
    <p class="tagline">The best Amazon deals, curated daily</p>
  </header>
  <div class="container">
    <h2 class="section-title">Today's Deals — ${todayDisp}</h2>
${dealsSection}
${archiveSection}
  </div>
  <footer>
    <p>As an Amazon Associate I earn from qualifying purchases at no extra cost to you.</p>
  </footer>
  <script src="app.js"></script>
</body>
</html>
`;
}

function generateArchivePage(deals, dateStr) {
  const dispDate = prettyDate(dateStr);

  const dealsSection = deals.length
    ? `  <div class="deals-grid">\n${deals.map(cardHtml).join('\n')}\n  </div>`
    : '  <p class="no-deals">No Amazon deals were found for this date.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Amazon Deals — ${dispDate} | Zol Deals</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header>
    <h1>Zol Deals</h1>
    <p class="tagline">The best Amazon deals, curated daily</p>
  </header>
  <div class="container">
    <a class="back-link" href="../index.html">← Back to today's deals</a>
    <h2 class="section-title">Amazon Deals — ${dispDate}</h2>
${dealsSection}
  </div>
  <footer>
    <p>As an Amazon Associate I earn from qualifying purchases at no extra cost to you.</p>
  </footer>
  <script src="../app.js"></script>
</body>
</html>
`;
}

// ══════════════════════════════════════════════════════════════════
//  ARCHIVE JSON
// ══════════════════════════════════════════════════════════════════

function loadArchive() {
  if (fs.existsSync(ARCHIVE_FILE)) {
    return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  }
  return [];
}

function saveArchive(dates) {
  const unique = [...new Set(dates)].sort().reverse();
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(unique, null, 2));
}

// ══════════════════════════════════════════════════════════════════
//  WHATSAPP FILE
// ══════════════════════════════════════════════════════════════════

function saveWhatsappFile(deals, dateStr) {
  const lines = [
    `🛍️ Zol Deals — ${dateStr}`,
    '='.repeat(40),
    '',
  ];

  if (deals.length) {
    deals.forEach((deal, i) => {
      lines.push(`${i + 1}. ${deal.title}`);
      lines.push(deal.waCopy);
      lines.push(deal.affiliateUrl);
      lines.push('');
    });
  } else {
    lines.push('No Amazon deals today.');
    lines.push('');
  }

  lines.push('-'.repeat(40));
  lines.push('As an Amazon Associate I earn from qualifying purchases.');

  const filename = `zoldeals_whatsapp_${dateStr}.txt`;
  const filepath = path.join(DESKTOP_PATH, filename);

  try {
    fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
    console.log(`  WhatsApp file saved → ${filepath}`);
  } catch (err) {
    console.log(`  WARNING: Could not save WhatsApp file: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  GIT PUSH
// ══════════════════════════════════════════════════════════════════

function gitPush(dateStr) {
  try {
    execSync(`git add "${SITE_DIR}" "${ARCHIVE_FILE}"`, { stdio: 'inherit' });

    // Check if there's anything to commit
    const status = execSync('git status --porcelain').toString().trim();
    if (!status) {
      console.log('  Nothing new to commit — already up to date.');
      return;
    }

    execSync(`git commit -m "Daily deals update: ${dateStr}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('  Pushed to GitHub. Netlify will redeploy shortly.');
  } catch (err) {
    console.log(`  WARNING: Git push failed: ${err.message}`);
    console.log('  Site files were generated locally — push manually if needed.');
  }
}

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════

async function main() {
  const today = todayStr();
  console.log('\n' + '═'.repeat(52));
  console.log(`  Zol Deals — Running for ${today}`);
  console.log('═'.repeat(52) + '\n');

  // Create output folders if they don't exist yet
  fs.mkdirSync(DEALS_DIR, { recursive: true });

  // Set up Groq AI client
  const apiKey = process.env.GROQ_API_KEY;
  let groqClient = null;
  if (!apiKey) {
    console.log('⚠  GROQ_API_KEY not set — AI rewriting will use fallback text.\n');
  } else {
    groqClient = new Groq({ apiKey });
    console.log('  Groq AI client ready.\n');
  }

  // Load today's cache (deals already processed this run/earlier today)
  const cachedDeals = loadCache(today);
  const cachedUrls  = new Set(cachedDeals.map(d => d.sourceUrl));
  console.log(`  ${cachedDeals.length} deal(s) already in today's cache.\n`);

  // Step 1: Get post links from homepage
  const postLinks = await getPostLinks();
  if (!postLinks.length) {
    console.log('No posts found. Exiting.');
    return;
  }

  // Step 2: Scrape each post — skip any URL already in the cache
  console.log('Checking each post for Amazon links...');
  const newRawDeals = [];
  for (let i = 0; i < postLinks.length; i++) {
    const url = postLinks[i];
    if (cachedUrls.has(url)) {
      console.log(`  [${i + 1}/${postLinks.length}] (cached) ${url}`);
      continue; // already processed — skip scraping entirely
    }
    console.log(`  [${i + 1}/${postLinks.length}] ${url}`);
    const deal = await scrapePost(url);
    if (deal) {
      newRawDeals.push(deal);
      console.log(`       ✓ New deal: ${deal.title.slice(0, 55)}...`);
    }
    await sleep(1500); // polite pause between requests
  }
  console.log(`\n  ${newRawDeals.length} new deal(s) found this run.\n`);

  // Step 3: Rewrite only NEW deals with AI
  const newEnrichedDeals = [];
  if (newRawDeals.length) console.log('Rewriting new deals with Groq AI...');
  for (const deal of newRawDeals) {
    console.log(`  Rewriting: ${deal.title.slice(0, 55)}...`);
    const { webCopy, waCopy } = groqClient
      ? await rewriteDeal(groqClient, deal.title, deal.description, deal.promoCode)
      : {
          webCopy: `${deal.description.slice(0, 200).trimEnd()} Grab it here →`,
          waCopy:  'Hot deal on Amazon today! 🛒 Check it out.',
        };
    newEnrichedDeals.push({ ...deal, webCopy, waCopy });
    if (groqClient) await sleep(2000); // polite pause between Groq AI requests
  }

  // Merge new deals with cached deals (newest first).
  // Also drop any stale non-product entries that slipped into the cache before
  // isAmazonLink() was tightened — they have affiliateUrls like amazon.com/prime.
  const enrichedDeals = [...newEnrichedDeals, ...cachedDeals]
    .filter(d => d.affiliateUrl &&
      (d.affiliateUrl.includes('/dp/') ||
       d.affiliateUrl.includes('/gp/product/') ||
       d.affiliateUrl.includes('amzn.to')));

  // Save updated cache for today
  if (newEnrichedDeals.length > 0) {
    saveCache(today, enrichedDeals);
    console.log(`  Cache updated — ${enrichedDeals.length} total deal(s) today.\n`);
  } else {
    console.log('  No new deals this run — nothing to update.\n');
  }

  // Step 4: Load archive, add today
  const archiveDates = loadArchive();
  if (!archiveDates.includes(today)) archiveDates.push(today);

  // Step 5: Write HTML files
  console.log('\nGenerating website files...');

  fs.writeFileSync(path.join(SITE_DIR, 'style.css'), SITE_CSS, 'utf8');
  console.log(`  Written: ${SITE_DIR}/style.css`);

  fs.writeFileSync(path.join(SITE_DIR, 'app.js'), SITE_JS, 'utf8');
  console.log(`  Written: ${SITE_DIR}/app.js`);

  fs.writeFileSync(path.join(SITE_DIR, 'index.html'), generateIndex(enrichedDeals, archiveDates), 'utf8');
  console.log(`  Written: ${SITE_DIR}/index.html`);

  fs.writeFileSync(path.join(DEALS_DIR, `${today}.html`), generateArchivePage(enrichedDeals, today), 'utf8');
  console.log(`  Written: ${DEALS_DIR}/${today}.html`);

  // Step 6: Update archive.json
  saveArchive(archiveDates);
  console.log(`  Updated: ${ARCHIVE_FILE}`);

  // If no new deals were found, nothing else to do
  if (newEnrichedDeals.length === 0) {
    console.log('No new deals found this run. Checking again next cycle.');
    console.log('═'.repeat(52) + '\n');
    return;
  }

  // Step 7: Save WhatsApp file
  // On your PC: saves to Desktop as usual
  // On GitHub Actions (cloud): skipped — no Desktop available
  if (!IS_CI) {
    console.log('Saving WhatsApp file...');
    saveWhatsappFile(enrichedDeals, today);
  } else {
    console.log('Running in cloud — skipping WhatsApp Desktop file.');
  }

  // Step 8: Push to GitHub
  // On your PC: script pushes directly
  // On GitHub Actions: the workflow yml handles the commit/push instead
  if (!IS_CI) {
    console.log('\nPushing to GitHub...');
    gitPush(today);
  } else {
    console.log('Running in cloud — git push handled by workflow.');
  }

  console.log('\n' + '═'.repeat(52));
  console.log(`  Done! ${newEnrichedDeals.length} new deal(s) added.`);
  console.log(`  ${enrichedDeals.length} total deal(s) live for ${today}.`);
  console.log('═'.repeat(52) + '\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
