#!/usr/bin/env python3
"""
Zol Deals — Daily Amazon Affiliate Deals Automation
=====================================================
This script does everything automatically each day:
  1. Scrapes today's deals from tjbdeals.com
  2. Filters for Amazon-only deals
  3. Rewrites copy using the Claude AI API
  4. Generates a static HTML website
  5. Pushes to GitHub (Netlify auto-deploys)
  6. Saves a WhatsApp broadcast file to your Desktop

Run it manually:  python scraper.py
Scheduled daily:  Windows Task Scheduler (see setup guide)
"""

import os
import re
import json
import time
import datetime
import subprocess
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

import requests
from bs4 import BeautifulSoup
import anthropic


# ══════════════════════════════════════════════════════════════════
#  CONFIGURATION — edit these if anything changes
# ══════════════════════════════════════════════════════════════════

AFFILIATE_TAG  = "gowns04-20"                  # Your Amazon Associates tag
SOURCE_URL     = "https://www.tjbdeals.com"     # Site we scrape deals from
SITE_DIR       = "zol-deals-site"              # Output folder for the website
DEALS_DIR      = os.path.join(SITE_DIR, "deals")  # Sub-folder for archive pages
ARCHIVE_FILE   = "archive.json"                # Tracks all past deal dates
DESKTOP_PATH   = r"C:\Users\it\Desktop"        # Where WhatsApp file is saved

# Realistic browser header so we don't get blocked while scraping
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}


# ══════════════════════════════════════════════════════════════════
#  AFFILIATE LINK HELPERS
# ══════════════════════════════════════════════════════════════════

def tag_amazon_link(url):
    """
    Add our affiliate tag to any Amazon or amzn.to link.
    amzn.to short links: just append ?tag=gowns04-20
    Full amazon.com URLs: replace or add the tag= parameter
    """
    if "amzn.to" in url:
        # Short link — just tack on the tag
        if "?" in url:
            return url + f"&tag={AFFILIATE_TAG}"
        else:
            return url + f"?tag={AFFILIATE_TAG}"
    elif "amazon.com" in url:
        # Full URL — parse it and swap the tag parameter
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        params["tag"] = [AFFILIATE_TAG]
        flat_params = {k: v[0] for k, v in params.items()}
        new_query = urlencode(flat_params)
        return urlunparse(parsed._replace(query=new_query))
    return url  # Not an Amazon link — return unchanged


def is_amazon_link(url):
    """Return True if this URL points to Amazon or an amzn.to short link."""
    return "amzn.to" in url or "amazon.com" in url


# ══════════════════════════════════════════════════════════════════
#  SCRAPING
# ══════════════════════════════════════════════════════════════════

def get_post_links():
    """
    Fetch the tjbdeals.com homepage and collect all individual post links.
    Returns a list of URLs like https://tjbdeals.com/?p=12345
    """
    print("Fetching tjbdeals.com homepage...")
    try:
        resp = requests.get(SOURCE_URL, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ERROR fetching homepage: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    # Collect unique post links — WordPress post ID format (?p=XXXXX)
    # and also slug-style links under the same domain
    post_links = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        # Skip empty, anchor-only, or off-site links
        if not href or href.startswith("#") or not href.startswith("http"):
            continue
        if "tjbdeals.com" not in href:
            continue
        # Include WordPress post ID links and post slug links
        if "?p=" in href or (href.count("/") >= 4 and href != SOURCE_URL + "/"):
            post_links.add(href)

    print(f"  Found {len(post_links)} post links on homepage.\n")
    return list(post_links)


def scrape_post(url):
    """
    Fetch a single deal post page and extract:
      - title
      - description text
      - first Amazon affiliate link (tagged with our ID)

    Returns a dict if an Amazon link was found, or None to skip this post.
    """
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        print(f"  Skipping (load error): {url} — {e}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Collect all Amazon links on this page
    amazon_links = [
        a["href"] for a in soup.find_all("a", href=True)
        if is_amazon_link(a["href"])
    ]

    if not amazon_links:
        print(f"  No Amazon links — skipping: {url}")
        return None

    # Extract the post title
    title_tag = (
        soup.find("h1", class_="entry-title")
        or soup.find("h1", class_="post-title")
        or soup.find("h1")
    )
    title = title_tag.get_text(strip=True) if title_tag else "Amazon Deal"

    # Extract description from the post body (first few paragraphs)
    content_div = (
        soup.find("div", class_="entry-content")
        or soup.find("div", class_="post-content")
        or soup.find("article")
    )
    if content_div:
        paragraphs = content_div.find_all("p")
        description = " ".join(p.get_text(strip=True) for p in paragraphs[:3])
    else:
        description = title

    # Tag the first Amazon link with our affiliate ID
    affiliate_url = tag_amazon_link(amazon_links[0])

    return {
        "title": title,
        "description": description[:800],  # cap to avoid huge prompts
        "affiliate_url": affiliate_url,
        "source_url": url,
    }


# ══════════════════════════════════════════════════════════════════
#  AI REWRITING  (uses Claude Haiku — fast and cheap)
# ══════════════════════════════════════════════════════════════════

def rewrite_deal(client, title, description):
    """
    Ask Claude to rewrite a deal into two versions:
      - Website version: punchy prose, ends with "Grab it here →"
      - WhatsApp version: casual, emojis, under 50 words

    If the API call fails for any reason, we fall back to the original text
    so the script keeps running rather than crashing.
    """
    prompt = f"""You are a copywriter for Zol Deals, an Amazon deals site.

Rewrite this deal in TWO versions:

DEAL TITLE: {title}
DEAL DESCRIPTION: {description}

VERSION 1 - WEBSITE
2-3 punchy sentences. Highlights the value or savings. Ends with "Grab it here →".
Plain prose only — no markdown, no bullet points, no asterisks.

VERSION 2 - WHATSAPP
1-2 casual sentences. Include 1-2 relevant emojis. Under 50 words total.
Should feel like a tip from a friend.

Reply in this EXACT format (do not add anything before or after):
WEBSITE: [your website copy here]
WHATSAPP: [your whatsapp copy here]"""

    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=350,
            messages=[{"role": "user", "content": prompt}]
        )
        text = message.content[0].text.strip()

        # Parse the two sections out of the response
        web_match = re.search(r"WEBSITE:\s*(.+?)(?=WHATSAPP:|$)", text, re.DOTALL)
        wa_match  = re.search(r"WHATSAPP:\s*(.+?)$", text, re.DOTALL)

        web_copy = web_match.group(1).strip() if web_match else None
        wa_copy  = wa_match.group(1).strip()  if wa_match  else None

        if web_copy and wa_copy:
            return web_copy, wa_copy

    except Exception as e:
        print(f"  AI rewrite failed ({e}) — using fallback text.")

    # Fallback: use trimmed original text
    fallback_web = f"{description[:200].rstrip()} Grab it here →"
    fallback_wa  = "Hot deal on Amazon today! 🛒 Worth checking out."
    return fallback_web, fallback_wa


# ══════════════════════════════════════════════════════════════════
#  CSS  (written once into style.css — all pages share it)
# ══════════════════════════════════════════════════════════════════

SITE_CSS = """\
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5;
    color: #333;
    line-height: 1.6;
}

/* ── Header ── */
header {
    background: #232f3e;
    color: #fff;
    padding: 24px 16px;
    text-align: center;
}
header h1 {
    font-size: 2.2rem;
    color: #FF9900;
    letter-spacing: -0.5px;
}
header p.tagline {
    font-size: 1rem;
    color: #b0b8c1;
    margin-top: 4px;
}

/* ── Layout ── */
.container {
    max-width: 960px;
    margin: 0 auto;
    padding: 28px 16px;
}

h2.section-title {
    font-size: 1.4rem;
    color: #232f3e;
    border-bottom: 3px solid #FF9900;
    padding-bottom: 8px;
    margin-bottom: 20px;
}

/* ── Deal cards ── */
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
.deal-card:hover {
    box-shadow: 0 4px 18px rgba(0,0,0,0.14);
}
.deal-card h3 {
    font-size: 1rem;
    color: #111;
    line-height: 1.45;
}
.deal-card p {
    font-size: 0.93rem;
    color: #555;
    flex-grow: 1;
}

/* ── CTA button ── */
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

/* ── No-deals placeholder ── */
.no-deals {
    text-align: center;
    color: #999;
    padding: 48px 20px;
    font-size: 1.1rem;
    background: #fff;
    border-radius: 10px;
    margin-bottom: 48px;
}

/* ── Archive links ── */
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
.archive-list a:hover {
    background: #FF9900;
    color: #fff;
}

/* ── Back link ── */
.back-link {
    display: inline-block;
    color: #FF9900;
    text-decoration: none;
    font-weight: 600;
    margin-bottom: 20px;
    font-size: 0.95rem;
}
.back-link:hover { text-decoration: underline; }

/* ── Footer ── */
footer {
    background: #232f3e;
    color: #8a97a5;
    text-align: center;
    padding: 20px 16px;
    font-size: 0.82rem;
}

/* ── Mobile ── */
@media (max-width: 600px) {
    .deals-grid { grid-template-columns: 1fr; }
    header h1 { font-size: 1.6rem; }
}
"""


# ══════════════════════════════════════════════════════════════════
#  HTML GENERATION
# ══════════════════════════════════════════════════════════════════

def html_escape(text):
    """Escape HTML special characters to prevent broken markup."""
    return (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
    )


def card_html(deal):
    """Return the HTML block for a single deal card."""
    title = html_escape(deal["title"])
    copy  = html_escape(deal["website_copy"])
    url   = deal["affiliate_url"]
    return (
        f'    <div class="deal-card">\n'
        f'      <h3>{title}</h3>\n'
        f'      <p>{copy}</p>\n'
        f'      <a class="btn" href="{url}" target="_blank" rel="noopener sponsored">'
        f'Shop on Amazon →</a>\n'
        f'    </div>'
    )


def generate_index(deals, archive_dates):
    """Build and return the full HTML for index.html (the homepage)."""
    today_str  = datetime.date.today().strftime("%Y-%m-%d")
    today_disp = datetime.date.today().strftime("%B %d, %Y")

    # Deal cards section
    if deals:
        cards_html = "\n".join(card_html(d) for d in deals)
        deals_section = f'  <div class="deals-grid">\n{cards_html}\n  </div>'
    else:
        deals_section = '  <p class="no-deals">No Amazon deals found today. Check back tomorrow!</p>'

    # Archive links — last 30 past dates, newest first, exclude today
    past_dates = [d for d in sorted(archive_dates, reverse=True) if d != today_str][:30]
    if past_dates:
        items = "\n".join(
            f'      <li><a href="deals/{d}.html">'
            f'{datetime.datetime.strptime(d, "%Y-%m-%d").strftime("%b %d, %Y")}'
            f'</a></li>'
            for d in past_dates
        )
        archive_section = (
            f'    <h2 class="section-title">Past Deals</h2>\n'
            f'    <ul class="archive-list">\n{items}\n    </ul>'
        )
    else:
        archive_section = ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zol Deals — Best Amazon Deals Today</title>
  <meta name="description" content="The best Amazon deals, curated daily. Hand-picked savings updated every morning.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Zol Deals</h1>
    <p class="tagline">The best Amazon deals, curated daily</p>
  </header>
  <div class="container">
    <h2 class="section-title">Today's Deals — {today_disp}</h2>
{deals_section}
{archive_section}
  </div>
  <footer>
    <p>As an Amazon Associate I earn from qualifying purchases at no extra cost to you.</p>
  </footer>
</body>
</html>
"""


def generate_archive_page(deals, date_str):
    """Build and return the HTML for a dated archive page (e.g. deals/2026-03-06.html)."""
    date_obj   = datetime.datetime.strptime(date_str, "%Y-%m-%d")
    disp_date  = date_obj.strftime("%B %d, %Y")

    if deals:
        cards_html = "\n".join(card_html(d) for d in deals)
        deals_section = f'  <div class="deals-grid">\n{cards_html}\n  </div>'
    else:
        deals_section = '  <p class="no-deals">No Amazon deals were found for this date.</p>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Amazon Deals — {disp_date} | Zol Deals</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header>
    <h1>Zol Deals</h1>
    <p class="tagline">The best Amazon deals, curated daily</p>
  </header>
  <div class="container">
    <a class="back-link" href="../index.html">← Back to today's deals</a>
    <h2 class="section-title">Amazon Deals — {disp_date}</h2>
{deals_section}
  </div>
  <footer>
    <p>As an Amazon Associate I earn from qualifying purchases at no extra cost to you.</p>
  </footer>
</body>
</html>
"""


# ══════════════════════════════════════════════════════════════════
#  ARCHIVE JSON  (tracks all past deal dates)
# ══════════════════════════════════════════════════════════════════

def load_archive():
    """Load archive.json. Returns an empty list if the file doesn't exist yet."""
    if os.path.exists(ARCHIVE_FILE):
        with open(ARCHIVE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_archive(dates):
    """Write the updated list of dates back to archive.json."""
    with open(ARCHIVE_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(set(dates), reverse=True), f, indent=2)


# ══════════════════════════════════════════════════════════════════
#  WHATSAPP BROADCAST FILE
# ══════════════════════════════════════════════════════════════════

def save_whatsapp_file(deals, date_str):
    """
    Write a plain-text WhatsApp broadcast file to the Windows Desktop.
    Each deal gets a number, the casual copy, and the affiliate link.
    """
    lines = [
        f"🛍️ Zol Deals — {date_str}",
        "=" * 40,
        "",
    ]

    if deals:
        for i, deal in enumerate(deals, 1):
            lines.append(f"{i}. {deal['title']}")
            lines.append(deal["whatsapp_copy"])
            lines.append(deal["affiliate_url"])
            lines.append("")
    else:
        lines.append("No Amazon deals today.")
        lines.append("")

    lines += [
        "-" * 40,
        "As an Amazon Associate I earn from qualifying purchases.",
    ]

    filename = f"zoldeals_whatsapp_{date_str}.txt"
    filepath = os.path.join(DESKTOP_PATH, filename)

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"  WhatsApp file saved → {filepath}")
    except Exception as e:
        print(f"  WARNING: Could not save WhatsApp file: {e}")


# ══════════════════════════════════════════════════════════════════
#  GIT PUSH  (commits updated site files and pushes to GitHub)
# ══════════════════════════════════════════════════════════════════

def git_push(date_str):
    """
    Stage all website files, commit with today's date, and push to GitHub.
    Netlify will automatically pick up the push and redeploy the site.
    """
    try:
        # Stage the generated site folder and the archive index
        subprocess.run(["git", "add", SITE_DIR, ARCHIVE_FILE], check=True)

        # Check if there's actually anything to commit
        status = subprocess.run(
            ["git", "status", "--porcelain"], capture_output=True, text=True
        )
        if not status.stdout.strip():
            print("  Nothing new to commit — site already up to date.")
            return

        subprocess.run(
            ["git", "commit", "-m", f"Daily deals update: {date_str}"],
            check=True
        )
        subprocess.run(["git", "push"], check=True)
        print("  Pushed to GitHub successfully. Netlify will redeploy shortly.")

    except subprocess.CalledProcessError as e:
        print(f"  WARNING: Git push failed: {e}")
        print("  The site files were generated locally — push manually if needed.")


# ══════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════

def main():
    today = datetime.date.today().strftime("%Y-%m-%d")
    print(f"\n{'═' * 52}")
    print(f"  Zol Deals — Running for {today}")
    print(f"{'═' * 52}\n")

    # ── Create output directories if they don't exist yet ──────────
    os.makedirs(DEALS_DIR, exist_ok=True)

    # ── Set up the Anthropic client ────────────────────────────────
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("⚠  ANTHROPIC_API_KEY environment variable not set.")
        print("   AI rewriting will use fallback text.\n")
        client = None
    else:
        client = anthropic.Anthropic(api_key=api_key)
        print("  Anthropic client ready.\n")

    # ── Step 1: Collect post links from the homepage ───────────────
    post_links = get_post_links()
    if not post_links:
        print("No posts found on homepage. Exiting.")
        return

    # ── Step 2: Visit each post and extract Amazon deals ──────────
    print("Checking each post for Amazon links...")
    raw_deals = []
    for i, url in enumerate(post_links, 1):
        print(f"  [{i}/{len(post_links)}] {url}")
        deal = scrape_post(url)
        if deal:
            raw_deals.append(deal)
            print(f"       ✓ Deal found: {deal['title'][:55]}...")
        time.sleep(1.5)  # polite pause — don't hammer their server

    print(f"\n  {len(raw_deals)} Amazon deal(s) found.\n")

    if not raw_deals:
        print("No Amazon deals today. Generating empty pages anyway.\n")

    # ── Step 3: Rewrite each deal with AI ─────────────────────────
    enriched_deals = []
    if raw_deals:
        print("Rewriting deals with Claude AI...")
    for deal in raw_deals:
        print(f"  Rewriting: {deal['title'][:55]}...")
        if client:
            web_copy, wa_copy = rewrite_deal(client, deal["title"], deal["description"])
        else:
            # No API key — use original text
            web_copy = f"{deal['description'][:200].rstrip()} Grab it here →"
            wa_copy  = "Hot deal on Amazon today! 🛒 Check it out."

        enriched_deals.append({
            **deal,
            "website_copy":  web_copy,
            "whatsapp_copy": wa_copy,
        })

    # ── Step 4: Load archive dates, add today ─────────────────────
    archive_dates = load_archive()
    if today not in archive_dates:
        archive_dates.append(today)

    # ── Step 5: Write the HTML files ──────────────────────────────
    print("\nGenerating website files...")

    # style.css (shared by all pages)
    css_path = os.path.join(SITE_DIR, "style.css")
    with open(css_path, "w", encoding="utf-8") as f:
        f.write(SITE_CSS)
    print(f"  Written: {css_path}")

    # index.html (homepage — always shows today's deals)
    index_path = os.path.join(SITE_DIR, "index.html")
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(generate_index(enriched_deals, archive_dates))
    print(f"  Written: {index_path}")

    # deals/YYYY-MM-DD.html (archive page for today)
    archive_page = os.path.join(DEALS_DIR, f"{today}.html")
    with open(archive_page, "w", encoding="utf-8") as f:
        f.write(generate_archive_page(enriched_deals, today))
    print(f"  Written: {archive_page}")

    # ── Step 6: Update archive.json ───────────────────────────────
    save_archive(archive_dates)
    print(f"  Updated: {ARCHIVE_FILE}")

    # ── Step 7: Save WhatsApp broadcast file ──────────────────────
    print("\nSaving WhatsApp file...")
    save_whatsapp_file(enriched_deals, today)

    # ── Step 8: Push to GitHub (Netlify auto-deploys) ─────────────
    print("\nPushing to GitHub...")
    git_push(today)

    # ── Done ──────────────────────────────────────────────────────
    print(f"\n{'═' * 52}")
    print(f"  Done! {len(enriched_deals)} deal(s) processed for {today}.")
    print(f"{'═' * 52}\n")


if __name__ == "__main__":
    main()
