/**
 * crawl-galaxycine-2026.js
 * ------------------------------------------------------------
 * Crawl tối đa dữ liệu phim năm 2026 từ https://www.galaxycine.vn/
 *
 * Cách hoạt động:
 *  1. Mở các trang danh sách (đang chiếu / sắp chiếu / IMAX) bằng trình duyệt thật
 *     (site là Next.js, dữ liệu load bằng JS nên không dùng axios/cheerio được).
 *  2. Cuộn trang + bấm tab để load hết phim, gom link /dat-ve/<slug>.
 *  3. Vào từng trang chi tiết, lấy thông tin (tên, ngày khởi chiếu, thể loại,
 *     thời lượng, đạo diễn, diễn viên, mô tả, poster, trailer...).
 *  4. Chỉ giữ phim có NGÀY KHỞI CHIẾU thuộc năm 2026.
 *  5. Xuất ra galaxycine_2026.json và galaxycine_2026.csv
 *     (+ thư mục raw/ chứa JSON API gốc để bạn tinh chỉnh nếu cần).
 *
 * Cài đặt & chạy:
 *   npm init -y
 *   npm i playwright
 *   npx playwright install chromium
 *   node crawl-galaxycine-2026.js
 *
 * Tuỳ chọn:
 *   HEADLESS=false node crawl-galaxycine-2026.js     # xem trình duyệt chạy
 *   KEEP_UNKNOWN=true node crawl-galaxycine-2026.js  # giữ cả phim không rõ ngày
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ===================== CẤU HÌNH =====================
const BASE = 'https://www.galaxycine.vn';
const TARGET_YEAR = 2026;
const HEADLESS = process.env.HEADLESS !== 'false';
const KEEP_UNKNOWN = process.env.KEEP_UNKNOWN === 'true';
const DELAY_MS = [800, 1800]; // nghỉ ngẫu nhiên giữa các request
const OUT_DIR = __dirname;
const RAW_DIR = path.join(OUT_DIR, 'raw');

const LIST_PAGES = [
  { url: `${BASE}/phim-dang-chieu/`, tag: 'dang-chieu' },
  { url: `${BASE}/phim-sap-chieu/`, tag: 'sap-chieu' },
  { url: `${BASE}/phim-imax/`, tag: 'imax' },
  { url: `${BASE}/`, tag: 'trang-chu' },
];

// ===================== TIỆN ÍCH =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = ([a, b]) => Math.floor(a + Math.random() * (b - a));
const politeWait = () => sleep(rnd(DELAY_MS));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

fs.mkdirSync(RAW_DIR, { recursive: true });

/** Chuẩn hoá nhiều dạng ngày -> {iso, year}. Hỗ trợ dd/mm/yyyy, yyyy-mm-dd, ISO. */
function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  let m = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/); // dd/mm/yyyy
  if (m) return { iso: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, year: +m[3] };
  m = str.match(/(20\d{2})-(\d{2})-(\d{2})/); // yyyy-mm-dd
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, year: +m[1] };
  return null;
}

/** Duyệt đệ quy object JSON, thu mọi cặp key/value khớp điều kiện. */
function deepCollect(obj, test, out = [], pathKey = '') {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (test(k, v)) out.push({ key: k, value: v, path: pathKey + '.' + k });
      deepCollect(v, test, out, pathKey + '.' + k);
    }
  }
  return out;
}

const RELEASE_KEY = /(release|opening|khoi.?chieu|premiere|publish|start.?date|show.?date)/i;

/** Tìm ngày khởi chiếu từ nhiều nguồn JSON thu được. */
function findReleaseDate(jsonBlobs) {
  const cands = [];
  for (const blob of jsonBlobs) {
    deepCollect(blob, (k, v) => RELEASE_KEY.test(k) && typeof v === 'string' && parseDate(v), cands);
  }
  return cands.length ? parseDate(cands[0].value) : null;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
}

// ===================== BƯỚC 1: GOM LINK PHIM =====================
async function autoScroll(page, rounds = 25) {
  let lastHeight = 0;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(700);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) break;
    lastHeight = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function collectMovieLinks(context) {
  const links = new Map(); // url -> {title, sources:Set}
  const page = await context.newPage();

  // Bắt mọi response JSON (API danh sách phim) để tận dụng tối đa dữ liệu
  const apiMovies = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const url = res.url();
      if (!/galaxycine/i.test(url)) return;
      const body = await res.json();
      const file = path.join(RAW_DIR, `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
      fs.writeFileSync(file, JSON.stringify({ url, body }, null, 2));
      apiMovies.push({ url, body });
    } catch (_) {}
  });

  for (const lp of LIST_PAGES) {
    log('Mở trang danh sách:', lp.url);
    try {
      await page.goto(lp.url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      log('  ! timeout, tiếp tục với nội dung đã load');
    }
    await sleep(1500);

    // Trang chủ có tab "Đang chiếu / Sắp chiếu / Phim IMAX": bấm lần lượt
    if (lp.tag === 'trang-chu') {
      for (const label of ['Đang chiếu', 'Sắp chiếu', 'Phim IMAX']) {
        try {
          await page.getByText(label, { exact: true }).first().click({ timeout: 3000 });
          await sleep(1500);
          await autoScroll(page, 5);
        } catch (_) {}
      }
    }

    // Nếu có nút "Xem thêm" thì bấm đến hết
    for (let i = 0; i < 30; i++) {
      const btn = page.getByText(/xem thêm|load more/i).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click().catch(() => {});
      await sleep(1000);
    }
    await autoScroll(page);

    const found = await page.$$eval('a[href*="/dat-ve/"]', (as) =>
      as.map((a) => ({
        href: a.href,
        title: (a.getAttribute('title') || a.querySelector('img')?.alt || a.textContent || '').trim(),
      }))
    );
    for (const f of found) {
      const url = f.href.split('?')[0].split('#')[0];
      if (!links.has(url)) links.set(url, { url, title: f.title, sources: new Set() });
      links.get(url).sources.add(lp.tag);
    }
    log(`  -> tổng link phim hiện có: ${links.size}`);
    await politeWait();
  }

  await page.close();
  return { links: [...links.values()], apiMovies };
}

// ===================== BƯỚC 2: CÀO TRANG CHI TIẾT =====================
function extractField(text, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{1,300})', 'i');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

async function scrapeDetail(context, item) {
  const page = await context.newPage();
  const jsonBlobs = [];

  page.on('response', async (res) => {
    try {
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      if (!/galaxycine/i.test(res.url())) return;
      jsonBlobs.push(await res.json());
    } catch (_) {}
  });

  try {
    await page.goto(item.url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (_) {}
  await sleep(1200);

  // Gộp thêm __NEXT_DATA__ và JSON-LD nếu có
  const embedded = await page.evaluate(() => {
    const out = [];
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) try { out.push(JSON.parse(nd.textContent)); } catch (_) {}
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { out.push(JSON.parse(s.textContent)); } catch (_) {}
    });
    return out;
  });
  jsonBlobs.push(...embedded);

  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const meta = (p) => q(`meta[property="${p}"]`)?.content || q(`meta[name="${p}"]`)?.content || null;
    const iframe = [...document.querySelectorAll('iframe')].map((i) => i.src).find((s) => /youtube|youtu\.be/.test(s));
    return {
      title: q('h1')?.innerText?.trim() || meta('og:title'),
      description: meta('og:description') || meta('description'),
      poster: meta('og:image'),
      trailer: iframe || null,
      text: document.body.innerText,
    };
  });

  const text = dom.text || '';
  const release =
    findReleaseDate(jsonBlobs) ||
    parseDate(extractField(text, ['Khởi chiếu', 'Ngày khởi chiếu', 'Ngày chiếu', 'Release'])) ||
    null;

  // Phòng khi không có ngày: đoán năm theo đường dẫn ảnh CDN (/media/2026/..)
  const yearFromMedia = (dom.poster || '').match(/\/media\/(20\d{2})\//)?.[1];

  const movie = {
    url: item.url,
    slug: item.url.split('/').filter(Boolean).pop(),
    title: dom.title || item.title,
    release_date: release?.iso || null,
    release_year: release?.year || null,
    poster_year_hint: yearFromMedia ? +yearFromMedia : null,
    status: [...item.sources].join('|'),
    genre: extractField(text, ['Thể loại']),
    duration: extractField(text, ['Thời lượng']),
    country: extractField(text, ['Quốc gia', 'Xuất xứ']),
    director: extractField(text, ['Đạo diễn']),
    cast: extractField(text, ['Diễn viên']),
    rating: extractField(text, ['Phân loại', 'Giới hạn độ tuổi']),
    language: extractField(text, ['Ngôn ngữ']),
    description: dom.description,
    poster: dom.poster,
    trailer: dom.trailer,
    scraped_at: new Date().toISOString(),
  };

  // Lưu JSON gốc phục vụ debug / tinh chỉnh mapping field
  fs.writeFileSync(path.join(RAW_DIR, `detail_${movie.slug}.json`), JSON.stringify(jsonBlobs, null, 2));

  await page.close();
  return movie;
}

// ===================== MAIN =====================
(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  try {
    const { links } = await collectMovieLinks(context);
    log(`Tìm thấy ${links.length} phim. Bắt đầu cào chi tiết...`);

    const all = [];
    for (let i = 0; i < links.length; i++) {
      log(`[${i + 1}/${links.length}] ${links[i].url}`);
      try {
        all.push(await scrapeDetail(context, links[i]));
      } catch (e) {
        log('  ! lỗi:', e.message);
      }
      await politeWait();
    }

    // Lọc đúng năm 2026
    const movies2026 = all.filter((m) => {
      if (m.release_year) return m.release_year === TARGET_YEAR;
      return KEEP_UNKNOWN && m.poster_year_hint === TARGET_YEAR;
    });

    movies2026.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));

    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_all.json'), JSON.stringify(all, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_2026.json'), JSON.stringify(movies2026, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_2026.csv'), toCSV(movies2026));

    const unknown = all.filter((m) => !m.release_year).length;
    log('================ KẾT QUẢ ================');
    log(`Tổng phim cào được : ${all.length}`);
    log(`Phim năm ${TARGET_YEAR}      : ${movies2026.length}`);
    log(`Không rõ ngày chiếu: ${unknown} (xem galaxycine_all.json; đặt KEEP_UNKNOWN=true để giữ)`);
    log('File: galaxycine_2026.json, galaxycine_2026.csv');
  } finally {
    await browser.close();
  }
})();