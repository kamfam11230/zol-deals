/**
 * Zol Deals — Telegram Channel Watcher
 * ======================================
 * Monitors the TJBDeals public Telegram channel for new posts.
 * The moment a new post with an Amazon link appears, it triggers
 * scraper.js immediately — no more waiting for a timer.
 *
 * Run once:      node watcher.js
 * Auto-start:    Windows Task Scheduler → trigger "At log on" (runs forever)
 *
 * How it works:
 *   Every 2 minutes, fetches https://t.me/s/TJBDeals (tiny public HTML page)
 *   Finds any posts newer than the last one we saw
 *   If they contain Amazon links → runs scraper.js right away
 *   Saves the latest post ID so we never process the same post twice
 */

const axios    = require('axios');
const cheerio  = require('cheerio');
const fs       = require('fs');
const { execSync } = require('child_process');

// ══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════════

const CHANNEL_URL      = 'https://t.me/s/TJBDeals';
const LAST_SEEN_FILE   = 'last_seen_post.txt';   // tracks the last Telegram post ID we processed
const CHECK_INTERVAL   = 2 * 60 * 1000;          // check every 2 minutes (in milliseconds)

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36',
};

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function loadLastSeen() {
  if (fs.existsSync(LAST_SEEN_FILE)) {
    const val = parseInt(fs.readFileSync(LAST_SEEN_FILE, 'utf8').trim(), 10);
    return isNaN(val) ? 0 : val;
  }
  return 0;
}

function saveLastSeen(id) {
  fs.writeFileSync(LAST_SEEN_FILE, String(id), 'utf8');
}

function isAmazonLink(url) {
  return url.includes('amzn.to') || url.includes('amazon.com');
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ══════════════════════════════════════════════════════════════════
//  MAIN CHECK FUNCTION  (runs every 2 minutes)
// ══════════════════════════════════════════════════════════════════

async function checkChannel() {
  console.log(`[${timestamp()}] Checking TJBDeals Telegram channel...`);

  let html;
  try {
    const resp = await axios.get(CHANNEL_URL, { headers: HEADERS, timeout: 15000 });
    html = resp.data;
  } catch (err) {
    console.log(`  ⚠ Could not fetch channel page: ${err.message}`);
    return;
  }

  const $        = cheerio.load(html);
  const lastSeen = loadLastSeen();
  let   maxId    = lastSeen;
  let   newDeals = false;

  // Each post on the Telegram public page has: data-post="TJBDeals/1234"
  $('.tgme_widget_message').each((_, el) => {
    const dataPost = $(el).attr('data-post') || '';
    const postId   = parseInt(dataPost.split('/').pop(), 10);
    if (!postId) return;

    // Track the highest post ID seen
    if (postId > maxId) maxId = postId;

    // Skip posts we've already processed
    if (postId <= lastSeen) return;

    // Check if this new post contains any Amazon links
    let hasAmazon = false;
    $(el).find('a[href]').each((_, a) => {
      if (isAmazonLink($(a).attr('href') || '')) hasAmazon = true;
    });

    if (hasAmazon) {
      const preview = $(el).find('.tgme_widget_message_text').text().trim().slice(0, 60);
      console.log(`  🆕 New deal post #${postId}: "${preview}..."`);
      newDeals = true;
    } else {
      console.log(`  Post #${postId} — no Amazon links, skipping.`);
    }
  });

  // Save the newest post ID we've seen (even non-deal posts, so we don't re-check them)
  if (maxId > lastSeen) {
    saveLastSeen(maxId);
    console.log(`  Last seen post updated to #${maxId}`);
  }

  if (newDeals) {
    console.log(`\n  ✅ New deal(s) detected — running scraper now!\n`);
    try {
      execSync('node scraper.js', {
        stdio: 'inherit',
        cwd: __dirname,  // make sure it runs from the right folder
      });
    } catch (err) {
      console.log(`  ⚠ Scraper error: ${err.message}`);
    }
    console.log(`\n[${timestamp()}] Back to watching...\n`);
  } else {
    console.log(`  No new deals. Next check in 2 minutes.\n`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║   Zol Deals Watcher — TJBDeals Telegram     ║');
console.log('╚══════════════════════════════════════════════╝');
console.log(`Monitoring: ${CHANNEL_URL}`);
console.log(`Check interval: every 2 minutes`);
console.log('Press Ctrl+C to stop.\n');

// Run once immediately on start, then repeat every 2 minutes
checkChannel();
setInterval(checkChannel, CHECK_INTERVAL);
