/**
 * enrich-null-fields.js
 * ------------------------------------------------------------------
 * Đọc galaxy_cinemas.csv + galaxy_movies_2026.csv (do crawl-moveek-galaxy-2026.js tạo ra)
 * và BỔ SUNG các trường đang rỗng (null). Không ghi đè dữ liệu hợp lệ đang có.
 *
 * ── RẠP (galaxy_cinemas.csv) ────────────────────────────────────────────
 *   latitude, longitude  <- trang rạp trên galaxycine.vn (nếu có bản đồ nhúng)
 *                           -> không có thì geocode địa chỉ bằng OpenStreetMap Nominatim
 *   phone                <- trang rạp trên galaxycine.vn (số riêng của rạp)
 *                           -> không có thì dùng hotline chung của Galaxy (phoneSource ghi rõ)
 *   districtName         <- reverse geocode từ toạ độ (nhiều rạp địa chỉ mới đã bỏ cấp quận/huyện
 *                           nên có thể vẫn null — đó là bình thường)
 *
 * ── PHIM (galaxy_movies_2026.csv) ───────────────────────────────────────
 *   originalTitle, language, backdropUrl, trailerUrl, country, durationMin, synopsis, ageRating
 *   Nguồn theo thứ tự ưu tiên (mỗi trường khác nhau):
 *     1. Trang phim Moveek  (JSON-LD, nhãn trên trang, badge độ tuổi, nút trailer)
 *     2. Trang phim Galaxy  (galaxycine.vn/dat-ve/<slug>) — chỉ có với phim đang/sắp chiếu
 *     3. TMDB               (chỉ khi đặt TMDB_API_KEY) — nguồn tốt nhất cho originalTitle,
 *                            language, backdropUrl, trailer
 *   Đồng thời SỬA các lỗi dữ liệu của lần crawl trước:
 *     - ratingAvg đang theo thang 100 (vd 97) -> đổi về thang 5 của schema (4.85)
 *     - country chứa rác (vd '”.') -> xoá rồi lấy lại
 *     - ageRating = 'C' (sai) -> xoá rồi lấy lại
 *     - synopsis có câu quảng cáo "Review ... xem tại Moveek." -> bỏ câu đó
 *
 * Cài đặt & chạy:
 *   npm i playwright && npx playwright install chromium     (nếu chưa có)
 *   node enrich-null-fields.js                              # cả rạp + phim
 *   node enrich-null-fields.js --only=cinemas               # chỉ rạp
 *   node enrich-null-fields.js --only=movies                # chỉ phim
 *
 * Biến môi trường:
 *   INPUT_DIR=./            thư mục chứa 2 file CSV (mặc định: cùng thư mục script)
 *   TMDB_API_KEY=xxxx       API key (v3) hoặc Read Access Token (v4) của themoviedb.org — KHUYẾN NGHỊ
 *   CONTACT_EMAIL=you@x.com dùng trong User-Agent gửi Nominatim (theo chính sách của họ)
 *   MAX_MOVIES=10           chỉ xử lý N phim đầu (để thử)
 *   HEADLESS=false          xem trình duyệt chạy
 *
 * Kết quả (ghi cạnh file gốc, KHÔNG sửa file gốc):
 *   galaxy_cinemas_enriched.csv / .json
 *   galaxy_movies_2026_enriched.csv / .json
 *   enrich_report.txt  (thống kê trường còn rỗng)
 */

const fs = require('fs');
const path = require('path');

// ===================== CẤU HÌNH =====================
const INPUT_DIR = process.env.INPUT_DIR || __dirname;
const RAW_DIR = path.join(INPUT_DIR, 'raw');
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const CONTACT = process.env.CONTACT_EMAIL || 'no-contact@example.com';
const HEADLESS = process.env.HEADLESS !== 'false';
const MAX_MOVIES = process.env.MAX_MOVIES ? +process.env.MAX_MOVIES : Infinity;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';
const DELAY_MS = [1200, 2400];

const MOVEEK = 'https://moveek.com';
const GALAXY = 'https://www.galaxycine.vn';
const VALID_AGE = new Set(['P', 'K', 'T13', 'T16', 'T18']);

// ===================== TIỆN ÍCH =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = ([a, b]) => Math.floor(a + Math.random() * (b - a));
const politeWait = () => sleep(rnd(DELAY_MS));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Độ giống giữa 2 tiêu đề (Jaccard trên các từ đã bỏ dấu), 0..1 */
function similarity(a, b) {
  const A = new Set(slugify(a).split('-').filter(Boolean));
  const B = new Set(slugify(b).split('-').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => B.has(w) && inter++);
  return inter / (A.size + B.size - inter);
}

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const headers = clean[0] || [];
  return { headers, rows: clean.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows, headers) {
  const cols = [...new Set([...(headers || []), ...rows.flatMap((r) => Object.keys(r))])];
  return '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((h) => csvEscape(r[h])).join(','))].join('\n');
}
function readCSV(name) {
  const p = path.join(INPUT_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`Không thấy file ${p} (đặt INPUT_DIR hoặc để script cạnh file CSV)`);
  return parseCSV(fs.readFileSync(p, 'utf8'));
}

// ---------- làm sạch / chuẩn hoá ----------
/** Moveek chấm thang 100 (hoặc 10); schema CineHub dùng thang 5, Decimal(3,2). */
function normalizeRating(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n) || n <= 0) return 0;
  const five = n > 10 ? n / 20 : n > 5 ? n / 2 : n;
  return Math.round(Math.min(five, 5) * 100) / 100;
}

function cleanSynopsis(s) {
  if (blank(s)) return '';
  return String(s)
    .replace(/^\s*Review\s+.+?\s+và\s+lịch\s+chiếu\s+.+?\s+xem\s+tại\s+Moveek\.?\s*/is, '')
    .replace(/\s*Đặt vé ngay tại Moveek\.?\s*$/i, '')
    .trim();
}

function isValidCountry(s) {
  const t = String(s || '').trim();
  return !!t && t.length <= 30 && !/[.”"“]/.test(t) && /\p{L}/u.test(t);
}

function normalizeAge(s) {
  const t = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (VALID_AGE.has(t)) return t;
  const m = String(s || '').match(/(?:đủ|từ|trên)\s*(13|16|18)\s*tuổi/i);
  if (m) return `T${m[1]}`;
  if (/mọi\s*(lứa\s*)?tuổi|mọi\s*độ\s*tuổi/i.test(String(s))) return 'P';
  return null;
}

/** Tìm độ tuổi trong 1 đoạn text (chỉ nhận T13/T16/T18 vì P/K dễ nhầm). */
function ageFromText(text) {
  const m = String(text || '').match(/\b(T13|T16|T18)\b/);
  if (m) return m[1];
  return normalizeAge(String(text || '').match(/(?:đủ|từ)\s*(?:13|16|18)\s*tuổi/i)?.[0] || '') ;
}

const LANG_VI = { vi: 'Tiếng Việt', en: 'Tiếng Anh', ja: 'Tiếng Nhật', ko: 'Tiếng Hàn', zh: 'Tiếng Trung', cn: 'Tiếng Quảng Đông', th: 'Tiếng Thái', fr: 'Tiếng Pháp', es: 'Tiếng Tây Ban Nha', de: 'Tiếng Đức', hi: 'Tiếng Hindi', id: 'Tiếng Indonesia', ru: 'Tiếng Nga', it: 'Tiếng Ý', tl: 'Tiếng Philippines' };
const COUNTRY_VI = { US: 'Mỹ', GB: 'Anh', JP: 'Nhật Bản', KR: 'Hàn Quốc', CN: 'Trung Quốc', HK: 'Hồng Kông', TW: 'Đài Loan', TH: 'Thái Lan', VN: 'Việt Nam', FR: 'Pháp', DE: 'Đức', IN: 'Ấn Độ', CA: 'Canada', AU: 'Úc', ES: 'Tây Ban Nha', IT: 'Ý', RU: 'Nga', ID: 'Indonesia', PH: 'Philippines', MY: 'Malaysia', SG: 'Singapore', NZ: 'New Zealand', MX: 'Mexico', BR: 'Brazil', IE: 'Ireland', BE: 'Bỉ', SE: 'Thụy Điển', DK: 'Đan Mạch', NO: 'Na Uy', PL: 'Ba Lan', TR: 'Thổ Nhĩ Kỳ', AE: 'UAE' };

function toYoutubeUrl(s) {
  if (!s) return null;
  const m = String(s).match(/(?:youtube\.com\/(?:embed\/|watch\?v=|v\/)|youtu\.be\/)([\w-]{11})/);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}

// ===================== NOMINATIM (OpenStreetMap) =====================
const GEO_CACHE_FILE = path.join(RAW_DIR, 'enrich_geocode_cache.json');
let geoCache = {};
let lastGeoAt = 0;

async function nominatim(endpoint, params) {
  const key = endpoint + '?' + new URLSearchParams(params).toString();
  if (geoCache[key] !== undefined) return geoCache[key];
  const wait = 1150 - (Date.now() - lastGeoAt); // chính sách: tối đa 1 request/giây
  if (wait > 0) await sleep(wait);
  lastGeoAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/${endpoint}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': 'vi', ...params })}`;
  let data = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `cinehub-enrich/1.0 (${CONTACT})` } });
    data = res.ok ? await res.json() : null;
  } catch (e) {
    log('  ! Nominatim lỗi:', e.message);
  }
  geoCache[key] = data;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 1));
  return data;
}

function normalizeAddr(a) {
  return String(a || '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\bTp\.?\s*HCM\b/gi, 'Thành phố Hồ Chí Minh')
    .replace(/\bTP\.?\s*(?=\p{L})/giu, 'Thành phố ')
    .replace(/\bTp\.\s*/g, 'Thành phố ')
    .replace(/\bQ\.\s*/g, 'Quận ')
    .replace(/\bP\.\s*/g, 'Phường ')
    .replace(/\bTTTM\b/g, 'Trung tâm thương mại')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sinh các biến thể truy vấn từ chi tiết -> đơn giản dần (bỏ tầng/trung tâm thương mại, giữ số nhà + đường) */
function geocodeQueries(row) {
  const a = normalizeAddr(row.address);
  const province = String(row.provinceName || '').trim();
  const withProv = (txt) => (province && !slugify(txt).includes(slugify(province)) ? `${txt}, ${province}` : txt);

  const clean = (seg) =>
    seg
      .replace(/^(Tầng|Lầu)\s*\S+\s*(?:[-–—.,]\s*)?/i, '')   // "Tầng 4 ", "Lầu 2 "
      .replace(/^tầng trệt\s*/i, '')
      .trim();
  const dashTail = (seg) => { const p = seg.split(/\s[–—-]\s/); return p.length > 1 ? p[p.length - 1].trim() : seg; };
  const stripSo = (seg) => seg.replace(/^(?:.*[\s.])?(?:Số|số)\s+(?=\d)/, '');

  const segs = a.split(',').map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(Cửa|Sảnh|Tòa|tòa)\b/i.test(x))
    .map(clean).map(dashTail).map(stripSo).filter(Boolean);

  const street = segs.find((x) => /^\d+[A-Za-z]?(\s|bis)/.test(x));
  const admin = segs.filter((x) => /^(Phường|Quận|Huyện|Thị xã|Xã|Thành phố|Tỉnh)\s/i.test(x));

  const qs = [
    withProv(a),
    withProv(segs.join(', ')),
    street ? withProv([street, ...admin].join(', ')) : null,
    `${String(row.name).replace(/^Galaxy\s*/i, 'Galaxy Cinema ')}, ${province}`,
  ];
  return [...new Set(qs.filter(Boolean).map((q) => `${q}, Việt Nam`))];
}

const inVN = (lat, lon) => lat > 8 && lat < 24.5 && lon > 102 && lon < 110;

async function geocodeCinema(row) {
  const qs = geocodeQueries(row);
  for (let i = 0; i < qs.length; i++) {
    const r = await nominatim('search', { q: qs[i], countrycodes: 'vn', limit: '1' });
    if (r && r[0] && inVN(+r[0].lat, +r[0].lon)) {
      return { latitude: +(+r[0].lat).toFixed(6), longitude: +(+r[0].lon).toFixed(6), source: `nominatim:q${i + 1}`, query: qs[i] };
    }
  }
  return null;
}

async function reverseDistrict(lat, lon) {
  const r = await nominatim('reverse', { lat: String(lat), lon: String(lon), zoom: '14', addressdetails: '1' });
  const a = r?.address;
  if (!a) return null;
  const cands = [a.city_district, a.suburb, a.county, a.state_district, a.district].filter(Boolean);
  return cands.find((c) => /^(Quận|Huyện|Thị xã|Thành phố)\s/i.test(c) && !/Hồ Chí Minh$|Hà Nội$|Đà Nẵng$/i.test(c)) || null;
}

// ===================== PLAYWRIGHT HELPERS =====================
async function gotoSafe(page, url) {
  try { await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); } catch (_) { log('  ! timeout:', url); }
  await sleep(800);
}
async function autoScroll(page, rounds = 15) {
  let last = 0;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === last) break;
    last = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function clickMore(page) {
  for (let i = 0; i < 30; i++) {
    const btn = page.getByText(/xem thêm|load more/i).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click().catch(() => {});
    await sleep(900);
  }
}

// ===================== RẠP =====================
async function scrapeGalaxyCinemaSite(context, rows) {
  const page = await context.newPage();
  const out = { hotline: null, byExternalId: {} };
  log('Galaxy: danh sách rạp', `${GALAXY}/rap-gia-ve/`);
  await gotoSafe(page, `${GALAXY}/rap-gia-ve/`);
  await autoScroll(page, 6);
  await clickMore(page);

  const hotText = await page.evaluate(() => document.querySelector('footer')?.innerText || document.body.innerText);
  out.hotline = (hotText.match(/(1900[\s.]?\d{4})/) || [])[1]?.replace(/[\s.]/g, '') || null;

  const links = await page.$$eval('a[href*="/rap-gia-ve/"]', (as) =>
    as.map((a) => ({ href: a.href.split('?')[0].split('#')[0], text: (a.getAttribute('title') || a.innerText || a.querySelector('img')?.alt || '').trim() }))
      .filter((l) => /\/rap-gia-ve\/[^/]+\/?$/.test(l.href) && !/premium-hall/.test(l.href))
  );
  const uniq = [...new Map(links.map((l) => [l.href, l])).values()];
  log(`  -> ${uniq.length} trang rạp trên Galaxy, hotline: ${out.hotline || '?'}`);

  for (const row of rows) {
    // khớp theo tên (Galaxy hay đặt tên giống Moveek)
    const scored = uniq.map((l) => ({ ...l, score: similarity(l.text, row.name) })).sort((a, b) => b.score - a.score);
    if (!scored.length || scored[0].score < 0.6) continue;
    const m = scored[0];
    try {
      await gotoSafe(page, m.href);
      const d = await page.evaluate(() => {
        const inChrome = (e) => !!e.closest('footer,header,nav');
        const tel = [...document.querySelectorAll('a[href^="tel:"]')].filter((a) => !inChrome(a)).map((a) => a.getAttribute('href').replace('tel:', ''));
        return { tel, text: document.body.innerText, html: document.documentElement.outerHTML };
      });
      let phone = d.tel.find((t) => !/^\+?(84)?0?(1900|1800)/.test(t.replace(/\D/g, ''))) || null;
      if (!phone) {
        const lines = d.text.split('\n').map((l) => l.trim());
        const i = lines.findIndex((l) => /^(Điện thoại|SĐT|Số điện thoại|Hotline)\b/i.test(l));
        const cand = i >= 0 ? (lines.slice(i, i + 2).join(' ').match(/(0\d[\d. ]{8,12}\d)/) || [])[1] : null;
        if (cand && !/^(1900|1800)/.test(cand.replace(/\D/g, ''))) phone = cand;
      }
      let lat = null, lng = null, mm;
      if ((mm = d.html.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/))) { lng = +mm[1]; lat = +mm[2]; }
      else if ((mm = d.html.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/)) || (mm = d.html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) { lat = +mm[1]; lng = +mm[2]; }
      if (lat !== null && !inVN(lat, lng)) { lat = lng = null; }
      out.byExternalId[row.externalId] = { url: m.href, phone, lat, lng, score: m.score };
      log(`  khớp: ${row.name} -> ${m.href.split('/').slice(-2, -1)[0].slice(0, 8)} | phone=${phone || '-'} | map=${lat ? 'có' : '-'}`);
    } catch (e) {
      log('  ! lỗi trang rạp Galaxy', m.href, e.message);
    }
    await politeWait();
  }
  await page.close();
  return out;
}

async function enrichCinemas(context) {
  const { headers, rows } = readCSV('galaxy_cinemas.csv');
  log(`== RẠP: ${rows.length} dòng ==`);
  const galaxy = await scrapeGalaxyCinemaSite(context, rows);
  const stats = { lat: 0, phone: 0, hotline: 0, district: 0 };

  for (const r of rows) {
    const g = galaxy.byExternalId[r.externalId];
    if (g) r.galaxyUrl = g.url;

    // --- toạ độ ---
    if (blank(r.latitude) || blank(r.longitude)) {
      if (g?.lat) { r.latitude = g.lat; r.longitude = g.lng; r.geocodeSource = 'galaxycine.vn'; stats.lat++; }
      else {
        const geo = await geocodeCinema(r);
        if (geo) { r.latitude = geo.latitude; r.longitude = geo.longitude; r.geocodeSource = geo.source; r.geocodeQuery = geo.query; stats.lat++; }
        else log('  ! không geocode được:', r.name);
      }
    }

    // --- điện thoại ---
    if (blank(r.phone)) {
      if (g?.phone) { r.phone = g.phone.replace(/[^\d+]/g, ''); r.phoneSource = 'galaxycine.vn'; stats.phone++; }
      else if (galaxy.hotline) { r.phone = galaxy.hotline; r.phoneSource = 'chain-hotline'; stats.hotline++; }
    }

    // --- quận/huyện ---
    if (blank(r.districtName) && !blank(r.latitude)) {
      const d = await reverseDistrict(+r.latitude, +r.longitude);
      if (d) { r.districtName = d; r.districtSource = 'nominatim-reverse'; stats.district++; }
    }
  }

  fs.writeFileSync(path.join(INPUT_DIR, 'galaxy_cinemas_enriched.csv'), toCSV(rows, headers));
  fs.writeFileSync(path.join(INPUT_DIR, 'galaxy_cinemas_enriched.json'), JSON.stringify(rows, null, 2));
  log(`  Đã điền: toạ độ ${stats.lat}, phone riêng ${stats.phone}, hotline chung ${stats.hotline}, quận/huyện ${stats.district}`);
  return { headers, rows };
}

// ===================== PHIM =====================
/** Thu thập trang phim Moveek: JSON-LD + nhãn + badge độ tuổi + trailer. */
async function scrapeMoveekMovie(page, slug, dumpIdx) {
  await gotoSafe(page, `${MOVEEK}/phim/${slug}/`);
  const d = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const ld = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { ld.push(JSON.parse(s.textContent)); } catch (_) {} });

    const ageEls = [...document.querySelectorAll('span,div,a,small,label,strong,b')]
      .filter((e) => e.children.length === 0 && !e.closest('footer,nav,aside'))
      .filter((e) => {
        const t = (e.innerText || '').trim();
        if (/^(T13|T16|T18)$/.test(t)) return true;
        return /^(P|K)$/.test(t) && /(age|rating|badge|cert|limit)/i.test(String(e.className) + (e.title || ''));
      })
      .map((e) => e.innerText.trim());

    const html = document.documentElement.outerHTML;
    const ytAll = [...html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|v\/)|youtu\.be\/)([\w-]{11})/g)].map((m) => m[1]);
    const trailerEls = [...document.querySelectorAll('[data-youtube-id],[data-video-id],[data-trailer],[data-youtube],a[href*="youtube"],iframe[src*="youtube"],[data-src*="youtube"]')]
      .map((e) => e.getAttribute('data-youtube-id') || e.getAttribute('data-video-id') || e.getAttribute('data-youtube') || e.getAttribute('data-trailer') || e.href || e.src || e.getAttribute('data-src'));

    return {
      h1: q('h1')?.innerText?.trim() || null,
      text: document.body.innerText,
      ld,
      ageEls,
      yt: [...trailerEls.filter(Boolean), ...ytAll],
      ogImage: q('meta[property="og:image"]')?.content || null,
      ogDesc: q('meta[property="og:description"]')?.content || null,
    };
  });

  if (dumpIdx < 5) { // mẫu để bạn gửi lại cho tôi nếu cần chỉnh selector
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, `enrich_moveek_${slug}.json`), JSON.stringify({ ld: d.ld, ageEls: d.ageEls, yt: d.yt, textHead: d.text.slice(0, 3000) }, null, 2));
  }

  const ldMovie = d.ld.flat().flatMap((o) => (o && o['@graph'] ? o['@graph'] : [o])).find((o) => o && /Movie/i.test(String(o['@type'] || ''))) || {};
  const text = d.text || '';
  const label = (labels) => {
    for (const l of labels) {
      const m = text.match(new RegExp('(?:^|\\n)\\s*' + l + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{1,80})', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  };

  const alt = [].concat(ldMovie.alternateName || ldMovie.alternativeHeadline || []).find((x) => typeof x === 'string');
  const labelled = label(['Tên gốc', 'Tựa gốc', 'Tên khác', 'Original title']);
  const originalTitle = [labelled, alt].find((x) => x && slugify(x) !== slugify(d.h1 || ''));

  const ldCountry = [].concat(ldMovie.countryOfOrigin || []).map((c) => (typeof c === 'string' ? c : c?.name)).find(Boolean);
  const country = [label(['Quốc gia', 'Xuất xứ']), ldCountry].find(isValidCountry) || null;

  const iso = String(ldMovie.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const durationMin = iso && (iso[1] || iso[2]) ? (+iso[1] || 0) * 60 + (+iso[2] || 0) : +(text.match(/(\d{2,3})\s*phút/i)?.[1] || 0) || null;

  const trailerRaw = [ldMovie.trailer?.embedUrl, ldMovie.trailer?.url, ...d.yt].find((x) => toYoutubeUrl(x) || /^[\w-]{11}$/.test(x || ''));
  const trailerUrl = toYoutubeUrl(trailerRaw) || (/^[\w-]{11}$/.test(trailerRaw || '') ? `https://www.youtube.com/watch?v=${trailerRaw}` : null);

  const language = [ldMovie.inLanguage, label(['Ngôn ngữ'])].flat().find((x) => typeof x === 'string' && x.length <= 30) || null;
  const ageRating = normalizeAge(ldMovie.contentRating) || normalizeAge(d.ageEls[0]) || ageFromText(text.slice(0, 2500));
  const synopsis = cleanSynopsis(ldMovie.description || '') || cleanSynopsis(d.ogDesc && !/lịch chiếu .* và review/i.test(d.ogDesc) ? d.ogDesc : '');

  return { originalTitle, country, durationMin, trailerUrl, language, ageRating, synopsis, backdropUrl: null };
}

async function galaxyMovieIndex(context) {
  const page = await context.newPage();
  const found = new Map();
  for (const u of ['/phim-dang-chieu/', '/phim-sap-chieu/', '/phim-imax/']) {
    log('Galaxy: danh sách phim', GALAXY + u);
    await gotoSafe(page, GALAXY + u);
    await clickMore(page);
    await autoScroll(page);
    const items = await page.$$eval('a[href*="/dat-ve/"]', (as) =>
      as.map((a) => ({ href: a.href.split('?')[0].split('#')[0], title: (a.getAttribute('title') || a.querySelector('img')?.alt || a.innerText || '').trim() }))
    );
    items.forEach((i) => i.title && !found.has(i.href) && found.set(i.href, i));
    await politeWait();
  }
  await page.close();
  log(`  -> ${found.size} phim trên Galaxy`);
  return [...found.values()];
}

async function scrapeGalaxyMovie(page, url) {
  await gotoSafe(page, url);
  const d = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const yt = [...document.querySelectorAll('iframe[src*="youtube"],a[href*="youtube"],a[href*="youtu.be"]')].map((e) => e.src || e.href);
    return {
      h1: q('h1')?.innerText?.trim() || null,
      text: document.body.innerText,
      yt,
      og: q('meta[property="og:image"]')?.content || null,
      desc: q('meta[property="og:description"]')?.content || null,
    };
  });
  const text = d.text;
  const field = (labels) => {
    for (const l of labels) {
      const m = text.match(new RegExp(l + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{1,60})', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  };
  // Nội dung phim đầy đủ: từ "Nội Dung Phim" đến "Lịch Chiếu"
  const lines = text.split('\n').map((l) => l.trim());
  const a = lines.findIndex((l) => /^nội dung phim$/i.test(l));
  const b = lines.findIndex((l, i) => i > a && /^lịch chiếu$/i.test(l));
  const synopsis = a >= 0 ? lines.slice(a + 1, b > a ? b : undefined).filter(Boolean).join('\n') : '';
  const title = d.h1 || '';
  return {
    titleParts: title.split('/').map((s) => s.trim()).filter(Boolean),
    ageRating: normalizeAge(field(['Phân loại', 'Giới hạn độ tuổi'])) || ageFromText(text.slice(0, 2500)),
    country: [field(['Quốc gia', 'Xuất xứ'])].find(isValidCountry) || null,
    durationMin: +(text.match(/(\d{2,3})\s*(?:phút|min)/i)?.[1] || 0) || null,
    trailerUrl: d.yt.map(toYoutubeUrl).find(Boolean) || null,
    ogImage: d.og,
    synopsis,
  };
}

// ---------- TMDB ----------
async function tmdb(pathname, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  const headers = {};
  if (TMDB_KEY.length > 40) headers.Authorization = `Bearer ${TMDB_KEY}`;
  else url.searchParams.set('api_key', TMDB_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function tmdbLookup(row, galaxyTitleParts) {
  const year = (row.releaseDate || '').slice(0, 4);
  const names = [...new Set([...(galaxyTitleParts || []), row.title].filter(Boolean))];
  let best = null;
  for (const q of names) {
    for (const lang of ['vi-VN', 'en-US']) {
      const r = await tmdb('/search/movie', { query: q, language: lang, ...(year ? { year } : {}) }).catch(() => null);
      for (const c of r?.results || []) {
        const cy = (c.release_date || '').slice(0, 4);
        if (year && cy && Math.abs(+cy - +year) > 1) continue;
        const score = Math.max(...names.flatMap((n) => [similarity(n, c.title), similarity(n, c.original_title)]));
        if (!best || score > best.score) best = { id: c.id, score };
      }
    }
    if (best && best.score >= 0.8) break;
  }
  if (!best || best.score < 0.5) return null;

  const d = await tmdb(`/movie/${best.id}`, { language: 'vi-VN', append_to_response: 'videos', include_video_language: 'vi,en,null' });
  const vids = (d.videos?.results || []).filter((v) => v.site === 'YouTube' && /trailer/i.test(v.type));
  vids.sort((a, b) => (b.official - a.official) || String(b.published_at).localeCompare(String(a.published_at)));
  const c0 = d.production_countries?.[0];
  return {
    tmdbId: d.id,
    matchScore: Math.round(best.score * 100) / 100,
    originalTitle: d.original_title || null,
    language: LANG_VI[d.original_language] || d.original_language || null,
    country: c0 ? COUNTRY_VI[c0.iso_3166_1] || c0.name : null,
    durationMin: d.runtime || null,
    backdropUrl: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
    trailerUrl: vids[0] ? `https://www.youtube.com/watch?v=${vids[0].key}` : null,
    synopsis: d.overview || null,
  };
}

// ---------- gộp ----------
const PRIORITY = {
  originalTitle: ['tmdb', 'moveek', 'galaxy'],
  ageRating: ['moveek', 'galaxy'],
  trailerUrl: ['moveek', 'galaxy', 'tmdb'],
  backdropUrl: ['tmdb', 'galaxy'],
  language: ['tmdb', 'moveek'],
  country: ['moveek', 'galaxy', 'tmdb'],
  durationMin: ['moveek', 'galaxy', 'tmdb'],
  synopsis: ['galaxy', 'tmdb', 'moveek'],
};

async function enrichMovies(context) {
  const { headers, rows } = readCSV('galaxy_movies_2026.csv');
  log(`== PHIM: ${rows.length} dòng ==`);
  if (!TMDB_KEY) log('  (không có TMDB_API_KEY: originalTitle/language/backdropUrl sẽ thiếu nhiều — nên đặt key)');

  // 1. Làm sạch dữ liệu lỗi từ lần crawl trước
  const fixed = { rating: 0, country: 0, age: 0, synopsis: 0 };
  for (const r of rows) {
    const nr = normalizeRating(r.ratingAvg);
    if (String(nr) !== String(+r.ratingAvg)) { r.ratingSourceRaw = r.ratingAvg; fixed.rating++; }
    r.ratingAvg = nr;
    if (!blank(r.country) && !isValidCountry(r.country)) { r.country = ''; fixed.country++; }
    if (!blank(r.ageRating) && !VALID_AGE.has(r.ageRating)) { r.ageRating = ''; fixed.age++; }
    const cs = cleanSynopsis(r.synopsis);
    if (cs !== r.synopsis) { r.synopsis = cs; fixed.synopsis++; }
  }
  log(`  Đã sửa: ratingAvg ${fixed.rating}, country rác ${fixed.country}, ageRating sai ${fixed.age}, synopsis ${fixed.synopsis}`);

  // 2. Chuẩn bị nguồn
  const galaxyList = await galaxyMovieIndex(context);
  const page = await context.newPage();
  const FIELDS = Object.keys(PRIORITY);
  const todo = rows.filter((r) => FIELDS.some((f) => blank(r[f])));
  const batch = todo.slice(0, MAX_MOVIES);
  log(`  ${todo.length} phim còn trường rỗng; xử lý ${batch.length}`);

  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    log(`[${i + 1}/${batch.length}] ${r.slug}`);
    const src = {};
    r.filledFrom = '';

    // Moveek
    try { src.moveek = await scrapeMoveekMovie(page, r.slug, i); } catch (e) { log('  ! moveek:', e.message); }
    await politeWait();

    // Galaxy (khớp theo tên)
    const gm = galaxyList
      .map((g) => ({ ...g, score: Math.max(...g.title.split('/').map((p) => similarity(p, r.title))) }))
      .sort((a, b) => b.score - a.score)[0];
    if (gm && gm.score >= 0.75) {
      try {
        const g = await scrapeGalaxyMovie(page, gm.href);
        src.galaxy = { ...g, originalTitle: g.titleParts.length > 1 ? g.titleParts[0] : null, backdropUrl: g.ogImage && g.ogImage !== r.posterUrl ? g.ogImage : null };
        r.galaxyUrl = gm.href;
      } catch (e) { log('  ! galaxy:', e.message); }
      await politeWait();
    }

    // TMDB
    if (TMDB_KEY) {
      try {
        src.tmdb = await tmdbLookup(r, src.galaxy?.titleParts);
        if (src.tmdb) { r.tmdbId = src.tmdb.tmdbId; r.tmdbMatchScore = src.tmdb.matchScore; }
      } catch (e) { log('  ! tmdb:', e.message); }
    }

    // Gộp theo ưu tiên, chỉ điền chỗ trống
    const filled = {};
    for (const f of FIELDS) {
      if (!blank(r[f])) continue;
      for (const s of PRIORITY[f]) {
        let v = src[s]?.[f];
        if (f === 'ageRating') v = normalizeAge(v);
        if (f === 'country' && !isValidCountry(v)) v = null;
        if (f === 'synopsis') v = cleanSynopsis(v);
        if (!blank(v)) { r[f] = v; filled[f] = s; break; }
      }
    }
    r.filledFrom = JSON.stringify(filled);
  }
  await page.close();

  fs.writeFileSync(path.join(INPUT_DIR, 'galaxy_movies_2026_enriched.csv'), toCSV(rows, headers));
  fs.writeFileSync(path.join(INPUT_DIR, 'galaxy_movies_2026_enriched.json'), JSON.stringify(rows, null, 2));
  return { headers, rows };
}

// ===================== BÁO CÁO =====================
function report(name, rows, cols) {
  const lines = [`# ${name} (${rows.length} dòng) — số dòng còn rỗng`];
  for (const c of cols) lines.push(`  ${c.padEnd(16)} ${rows.filter((r) => blank(r[c])).length}`);
  return lines.join('\n');
}

// ===================== MAIN =====================
async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(RAW_DIR, { recursive: true });
  try { geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); } catch (_) {}

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const parts = [];
  try {
    if (ONLY === 'all' || ONLY === 'cinemas') {
      const c = await enrichCinemas(context);
      parts.push(report('galaxy_cinemas_enriched', c.rows, ['latitude', 'longitude', 'phone', 'districtName', 'address']));
    }
    if (ONLY === 'all' || ONLY === 'movies') {
      const m = await enrichMovies(context);
      parts.push(report('galaxy_movies_2026_enriched', m.rows, ['originalTitle', 'synopsis', 'durationMin', 'ageRating', 'backdropUrl', 'trailerUrl', 'language', 'country']));
    }
  } finally {
    await browser.close();
  }
  const txt = parts.join('\n\n');
  fs.writeFileSync(path.join(INPUT_DIR, 'enrich_report.txt'), txt);
  console.log('\n' + txt);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseCSV, toCSV, normalizeRating, cleanSynopsis, isValidCountry, normalizeAge, ageFromText, similarity, geocodeQueries, normalizeAddr, toYoutubeUrl };