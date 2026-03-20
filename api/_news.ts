/**
 * Shared RSS news fetching with a 1-hour in-memory cache.
 * Import fetchNews() from here — both market-news.ts and macro-picks.ts use this.
 */

export interface NewsItem {
  title:       string;
  description: string;
  pubDate:     string;
  link:        string;
  source:      string;
}

// ── 1-hour module-level cache ──────────────────────────────────────────────────

let _cache: { items: NewsItem[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000;

// ── Feed definitions ───────────────────────────────────────────────────────────

const FEEDS = [
  {
    url:    'https://news.google.com/rss/search?q=India+stock+market+NSE+Sensex&hl=en-IN&gl=IN&ceid=IN:en',
    source: 'Google News — Markets',
  },
  {
    url:    'https://news.google.com/rss/search?q=global+economy+geopolitical+oil+US+China+trade&hl=en-IN&gl=IN&ceid=IN:en',
    source: 'Google News — Macro',
  },
  {
    url:    'https://news.google.com/rss/search?q=India+pharma+telecom+renewable+energy+steel+fertilizer+PSU&hl=en-IN&gl=IN&ceid=IN:en',
    source: 'Google News — Sectors',
  },
  {
    url:    'https://economictimes.indiatimes.com/markets/stocks/rss.cms',
    source: 'Economic Times',
  },
] as const;

// ── RSS parsing ────────────────────────────────────────────────────────────────

function extractTag(content: string, tag: string): string | null {
  // CDATA variant
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const m1 = content.match(cdataRe);
  if (m1) return m1[1].trim();
  // Regular variant
  const regularRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m2 = content.match(regularRe);
  if (m2) return m2[1].trim();
  return null;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseRSS(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const content = match[1];
    const title   = extractTag(content, 'title');
    if (!title) continue;

    const description = extractTag(content, 'description') ?? '';
    const pubDate     = extractTag(content, 'pubDate') ?? new Date().toUTCString();
    let   link        = extractTag(content, 'link');

    // Google News RSS: link sometimes appears as a text node after <link/>
    if (!link) {
      const m = content.match(/<link[^>]*>(https?:\/\/[^\s<]+)/i);
      if (m) link = m[1];
    }
    if (!link) link = extractTag(content, 'guid') ?? '';

    items.push({
      title:       cleanHtml(title),
      description: cleanHtml(description).slice(0, 200),
      pubDate,
      link,
      source,
    });
  }
  return items;
}

// ── Filtering & deduplication ──────────────────────────────────────────────────

function isWithin48Hours(pubDate: string): boolean {
  try {
    const t = new Date(pubDate).getTime();
    return !isNaN(t) && Date.now() - t <= 48 * 60 * 60 * 1000;
  } catch {
    return true; // include if unparseable
  }
}

function isSimilar(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
  const wa     = words(a);
  const wb     = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const total  = new Set([...wa, ...wb]).size;
  return total > 0 && shared / total > 0.5;
}

function deduplicate(items: NewsItem[]): NewsItem[] {
  const result: NewsItem[] = [];
  for (const item of items) {
    if (!result.some((r) => isSimilar(r.title, item.title))) result.push(item);
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fetchNews(): Promise<{ items: NewsItem[]; fetchedAt: number; fromCache: boolean }> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL) {
    return { ..._cache, fromCache: true };
  }

  const results = await Promise.allSettled(
    FEEDS.map(({ url, source }) =>
      fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArthaCrawler/1.0)', Accept: 'application/rss+xml, text/xml, */*' },
      })
        .then((r) => r.text())
        .then((xml) => parseRSS(xml, source)),
    ),
  );

  const all: NewsItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  const filtered = all
    .filter((item) => isWithin48Hours(item.pubDate))
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  const items      = deduplicate(filtered).slice(0, 20);
  const fetchedAt  = Date.now();
  _cache = { items, fetchedAt };

  return { items, fetchedAt, fromCache: false };
}
