/**
 * crawl-galaxycine-2026.js
 * ------------------------------------------------------------------
 * Crawl dữ liệu Galaxy Cinema (https://www.galaxycine.vn/) cho năm 2026,
 * xuất JSON theo đúng các bảng/trường trong schema CineHub (Prisma).
 *
 * Bảng/trường lấy được từ Galaxy:
 *   CinemaChain  : code=GALAXY, name, logoUrl, websiteUrl, isActive
 *   Province     : code, name
 *   District     : provinceCode, name            (nếu địa chỉ còn cấp quận/huyện)
 *   Cinema       : externalId, name, address, provinceCode, districtName,
 *                  latitude, longitude, phone, timezone, isActive
 *   Genre        : slug, name
 *   Person       : fullName
 *   Movie        : slug, title, originalTitle, synopsis, durationMin, releaseDate,
 *                  ageRating, status, posterUrl, backdropUrl, trailerUrl,
 *                  language, country, ratingAvg, ratingCount
 *   MovieGenre / MovieCredit (DIRECTOR|ACTOR + billingOrder) / MovieSource
 *   Showtime     : dedupKey, startTime(UTC), endTime, format, language, status,
 *                  seatSource=MOCK, lastSyncedAt  (+ tham chiếu movieSlug, cinemaExternalId)
 *   Promotion    : title, imageUrl, linkUrl, description, startsAt, endsAt, sortOrder, isActive
 *   Voucher      : (best effort) code, type, value, startsAt, endsAt - nếu bài khuyến mãi có ghi mã
 *   Concession   : name, description, category, imageUrl, price (VND), cinemaExternalId (null = cả cụm)
 *   movie_metadata (Mongo): gallery, tags, sourceScore...
 *
 * KHÔNG lấy được từ Galaxy (do CineHub tự sinh/mô phỏng hoặc phát sinh từ người dùng):
 *   Auditorium, Seat, ShowtimeSeat, TicketType, SeatType, ShowtimePrice (chỉ lấy
 *   được nếu site hiển thị -> xem cinema.priceTables), User, Booking, Payment...
 *
 * Cài đặt & chạy:
 *   npm init -y && npm i playwright && npx playwright install chromium
 *   node crawl-galaxycine-2026.js
 *
 * Biến môi trường:
 *   HEADLESS=false      xem trình duyệt chạy
 *   KEEP_UNKNOWN=true   giữ phim không rõ ngày chiếu nếu poster nằm trong /media/2026/
 *   MAX_MOVIES=5        giới hạn số phim (để chạy thử)
 *   CONCURRENCY=3       số phim cào song song
 *   REGION_SWEEP=false  chỉ lấy "Toàn quốc", không quét từng tỉnh/thành
 *   CINEMA_SWEEP=true   quét thêm từng rạp trong từng tỉnh (đầy đủ nhất, chậm nhất)
 *   FRESH=true          bỏ qua file cũ (mặc định gộp/tích luỹ với galaxycine_2026.json)
 *
 * LƯU Ý "cả năm 2026": website chỉ hiển thị lịch chiếu ~7 ngày tới, không có lịch sử.
 * Hãy chạy script MỖI NGÀY (cron); mỗi lần chạy sẽ gộp thêm suất mới vào file cũ,
 * suất đã qua tự chuyển thành FINISHED.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== CẤU HÌNH =====================
const BASE = 'https://www.galaxycine.vn';
const CHAIN_CODE = 'GALAXY';
const TARGET_YEAR = 2026;
const HEADLESS = process.env.HEADLESS !== 'false';
const KEEP_UNKNOWN = process.env.KEEP_UNKNOWN === 'true';
const MAX_MOVIES = process.env.MAX_MOVIES ? +process.env.MAX_MOVIES : Infinity;
const CONCURRENCY = +(process.env.CONCURRENCY || 3);           // số phim cào song song
const REGION_SWEEP = process.env.REGION_SWEEP !== 'false';     // quét lần lượt từng tỉnh/thành trong dropdown
const CINEMA_SWEEP = process.env.CINEMA_SWEEP === 'true';      // quét thêm từng rạp (chậm hơn, đầy đủ nhất)
const FRESH = process.env.FRESH === 'true';                    // true = bỏ qua file cũ, không gộp
const OUT_FILE = path.join(__dirname, 'galaxycine_2026.json');
const PROMO_ALL = process.env.PROMO_ALL === 'true';           // giữ cả khuyến mãi không rõ ngày (mặc định bỏ)
const DELAY_MS = [800, 1800];
const OUT_DIR = __dirname;
const RAW_DIR = path.join(OUT_DIR, 'raw');

const MOVIE_LISTS = [
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
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const norm = (s) => String(s || '').toLowerCase().replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Chuẩn hoá ngày: dd/mm/yyyy | dd.mm.yyyy | yyyy-mm-dd -> {iso, year} */
function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  let m = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (m) return { iso: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, year: +m[3] };
  m = str.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, year: +m[1] };
  return null;
}

function deepCollect(obj, test, out = [], p = '') {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (test(k, v)) out.push({ key: k, value: v, path: p + '.' + k });
      deepCollect(v, test, out, p + '.' + k);
    }
  }
  return out;
}

const RELEASE_KEY = /(release|opening|khoi.?chieu|premiere|publish|start.?date)/i;
function findReleaseDate(blobs) {
  const c = [];
  for (const b of blobs) deepCollect(b, (k, v) => RELEASE_KEY.test(k) && typeof v === 'string' && parseDate(v), c);
  return c.length ? parseDate(c[0].value) : null;
}

/** Tìm id nội bộ của phim trong JSON API: object có 1 giá trị chuỗi chứa slug và có field id */
function findInternalId(blobs, slug) {
  let found = null;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return;
    if (!Array.isArray(o) && typeof o.id === 'string' && o.id.length >= 8) {
      if (Object.values(o).some((v) => typeof v === 'string' && v.split('/').filter(Boolean).pop() === slug)) {
        found = o.id;
        return;
      }
    }
    Object.values(o).forEach(walk);
  };
  blobs.forEach(walk);
  return found;
}

function findYoutube(blobs) {
  const c = [];
  for (const b of blobs) deepCollect(b, (k, v) => typeof v === 'string' && /(youtube\.com|youtu\.be)/.test(v), c);
  return c.length ? c[0].value : null;
}

/** Lấy các dòng giữa nhãn bắt đầu và nhãn kết thúc đầu tiên (xem innerText của trang). */
function sliceSection(text, startLabel, stopLabels = []) {
  const lines = text.split('\n').map((l) => l.trim());
  const start = norm(startLabel);
  const stops = stopLabels.map(norm);
  const isLabel = (l, lab) => norm(l) === lab || norm(l).startsWith(lab + ':');
  const i = lines.findIndex((l) => isLabel(l, start));
  if (i === -1) return [];
  const out = [];
  const inline = lines[i].split(/[:：]/).slice(1).join(':').trim();
  if (inline) out.push(inline);
  for (let j = i + 1; j < lines.length; j++) {
    if (stops.some((s) => isLabel(lines[j], s))) break;
    if (lines[j]) out.push(lines[j]);
  }
  return out;
}

function extractField(text, labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(label + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{1,300})', 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

async function autoScroll(page, rounds = 25) {
  let last = 0;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(700);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === last) break;
    last = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function expandContent(page) {
  for (const label of [/xem thêm/i, /đọc thêm/i, /read more/i]) {
    const btns = page.getByText(label);
    const n = Math.min(await btns.count().catch(() => 0), 5);
    for (let k = 0; k < n; k++) await btns.nth(k).click({ timeout: 1500 }).catch(() => {});
  }
  await sleep(400);
}

async function gotoSafe(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (_) {
    log('  ! timeout, dùng nội dung đã load:', url);
  }
  await sleep(1200);
}

/** Gắn bộ bắt JSON response vào page, trả về mảng chứa các JSON bắt được */
function captureJson(page, saveAs) {
  const blobs = [];
  page.on('response', async (res) => {
    try {
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      if (!/galaxycine/i.test(res.url())) return;
      const body = await res.json();
      blobs.push(body);
      if (saveAs) fs.writeFileSync(path.join(RAW_DIR, `${saveAs}_${blobs.length}.json`), JSON.stringify({ url: res.url(), body }, null, 2));
    } catch (_) {}
  });
  return blobs;
}

// ===================== MAPPING SANG ENUM / QUY ƯỚC SCHEMA =====================
function mapScreenFormat(line) {
  const s = String(line || '').toUpperCase();
  if (/IMAX/.test(s)) return 'IMAX';
  if (/4DX/.test(s)) return 'FOUR_DX';
  if (/SCREEN\s?X/.test(s)) return 'SCREENX';
  if (/3D/.test(s)) return 'THREE_D';
  return 'TWO_D';
}

function extractLanguage(line) {
  let s = String(line || '');
  for (let i = 0; i < 4; i++) s = s.replace(/^\s*(IMAX|2D|3D|4DX|SCREEN\s?X|\+|-)\s*/i, '');
  return s.trim() || null; // "Lồng Tiếng", "Phụ Đề"...
}

function mapAgeRating(s) {
  const m = String(s || '').toUpperCase().match(/\b(T13|T16|T18|P|K|C)\b/);
  return m ? m[1] : null;
}

const PROVINCE_CODES = { 'hồ chí minh': 'HCM', 'hà nội': 'HN', 'đà nẵng': 'DN', 'cần thơ': 'CT', 'hải phòng': 'HP' };

/** Tách tỉnh/thành và quận/huyện từ địa chỉ. Địa chỉ mới (2 cấp) có thể không có quận/huyện. */
function parseAddress(address) {
  if (!address) return { province: null, district: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean).filter((p) => !/^việt nam$/i.test(p));
  const last = parts[parts.length - 1] || '';
  const name = last.replace(/^(thành phố|tp\.?|tỉnh)\s+/i, '').trim();
  const code = PROVINCE_CODES[name.toLowerCase()] || slugify(name).toUpperCase().replace(/-/g, '_');
  const district = parts.find((p) => /^(quận|huyện|thị xã)\s/i.test(p)) || null;
  return { province: name ? { code, name: last } : null, district };
}

/** Parse dòng giờ chiếu từ innerText mục "Lịch Chiếu" của 1 ngày */
function parseShowtimeLines(lines) {
  const out = [];
  let cinema = null;
  let fmt = null;
  for (const l of lines) {
    if (/^Galaxy\b/i.test(l)) { cinema = l; fmt = null; continue; }
    if (/^(IMAX|2D|3D|4DX|SCREEN\s?X)\b/i.test(l)) { fmt = l; continue; }
    const m = l.match(/^(\d{1,2}):(\d{2})(?:\s|$)/);
    if (m && cinema) out.push({ cinemaName: cinema, formatLine: fmt, hour: +m[1], minute: +m[2] });
  }
  return out;
}

/** dd/mm -> năm hợp lý (xử lý chuyển năm tháng 12 -> tháng 1) */
function inferYear(dd, mm, now = new Date()) {
  let y = now.getFullYear();
  if (mm < now.getMonth() + 1 - 6) y += 1;
  return y;
}

/** Giờ địa phương VN (UTC+7) -> ISO UTC */
function vnToUtcIso(y, mo, d, h, mi) {
  const p = (n) => String(n).padStart(2, '0');
  return new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+07:00`).toISOString();
}

// ===================== CSV =====================
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
}

// ===================== 1. CINEMA CHAIN + RẠP + TỈNH/QUẬN =====================
async function scrapeCinemas(context) {
  const page = await context.newPage();
  captureJson(page, 'cinemas');
  log('Crawl danh sách rạp:', `${BASE}/rap-gia-ve/`);
  await gotoSafe(page, `${BASE}/rap-gia-ve/`);
  await autoScroll(page, 8);

  const logoUrl = await page.$eval('img[src*="logo"], img[alt*="Logo" i]', (i) => i.src).catch(() => null);
  const links = new Set(
    (await page.$$eval('a[href*="/rap-gia-ve/"]', (as) => as.map((a) => a.href.split('?')[0].split('#')[0])))
      .filter((u) => /\/rap-gia-ve\/[^/]+\/?$/.test(u) && !/premium-hall/.test(u))
  );
  log(`  -> ${links.size} trang rạp`);

  const cinemas = [];
  const cinemaCards = [];
  for (const url of links) {
    try {
      await gotoSafe(page, url);
      await expandContent(page);
      const info = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        return {
          name: q('h1')?.innerText?.trim() || q('meta[property="og:title"]')?.content || null,
          tel: q('a[href^="tel:"]')?.getAttribute('href')?.replace('tel:', '') || null,
          html: document.documentElement.outerHTML,
          text: document.body.innerText,
          tables: [...document.querySelectorAll('table')].map((t) =>
            [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.trim()))
          ),
        };
      });

      const stops = ['Điện thoại', 'Hotline', 'Số điện thoại', 'Giờ mở cửa', 'Giá vé', 'Lịch chiếu', 'Phim'];
      const addrLines = sliceSection(info.text, 'Địa chỉ', stops);
      let address = addrLines.slice(0, 2).join(', ') || null;
      if (!address) address = info.text.split('\n').find((l) => /(phường|quận|huyện|thành phố)/i.test(l) && l.includes(',')) || null;

      let lat = null, lng = null;
      let m = info.html.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
      if (m) { lng = +m[1]; lat = +m[2]; }
      else if ((m = info.html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)) || (m = info.html.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/))) {
        lat = +m[1]; lng = +m[2];
      }

      const phone = info.tel || (info.text.match(/(0\d[\d. ]{8,12}\d)/) || [])[1] || null;
      const { province, district } = parseAddress(address);
      const cards = await extractConcessionCards(page).catch(() => []);
      cinemaCards.push(...cards.map((c) => ({ ...c, cinemaExternalId: url.split('/').filter(Boolean).pop() })));

      cinemas.push({
        chainCode: CHAIN_CODE,
        externalId: url.split('/').filter(Boolean).pop(),
        name: info.name,
        address,
        provinceCode: province?.code || null,
        provinceName: province?.name || null,
        districtName: district,
        latitude: lat,
        longitude: lng,
        phone,
        timezone: 'Asia/Ho_Chi_Minh',
        isActive: true,
        url,
        priceTables: info.tables.length ? info.tables : null, // bảng giá vé thô nếu trang có
      });
      log('  rạp:', info.name);
    } catch (e) {
      log('  ! lỗi rạp', url, e.message);
    }
    await politeWait();
  }
  await page.close();
  return { cinemas, logoUrl, cinemaCards };
}

// ===================== 2. KHUYẾN MÃI (Promotion + Voucher) =====================
/** "từ 01/10 đến 31/10/2026", "01/10/2026 - 31/12/2026" -> {startsAt, endsAt} */
function parseRange(text) {
  const re = /(\d{1,2})[\/.](\d{1,2})(?:[\/.](20\d{2}))?\s*(?:-|–|—|đến hết ngày|đến ngày|đến|->)\s*(\d{1,2})[\/.](\d{1,2})[\/.](20\d{2})/i;
  const m = String(text || '').match(re);
  if (!m) return null;
  const ey = +m[6];
  const sy = m[3] ? +m[3] : ey;
  const p2 = (n) => String(n).padStart(2, '0');
  return { startsAt: `${sy}-${p2(m[2])}-${p2(m[1])}`, endsAt: `${ey}-${p2(m[5])}-${p2(m[4])}` };
}

/** Tìm mã voucher + loại/giá trị giảm trong nội dung khuyến mãi (best effort) */
function extractVoucherFromText(title, text, range, linkUrl) {
  const codeM = String(text || '').match(/(?:mã(?: giảm giá| khuyến mãi| ưu đãi| code)?|code|voucher)\s*[:：]?\s*["“']?([A-Z][A-Z0-9]{4,19})\b/);
  if (!codeM) return null;
  const pct = text.match(/(?:giảm|off)[^\d]{0,15}(\d{1,3})\s?%/i);
  const fix = text.match(/(?:giảm|off)[^\d]{0,15}(\d{1,3}(?:[.,]\d{3})+|\d{2,3}\s?k)/i);
  return {
    code: codeM[1],
    description: title,
    type: pct ? 'PERCENT' : 'FIXED',
    value: pct ? +pct[1] : fix ? parseVnd(fix[1]) : null,
    maxDiscount: null,
    minOrderAmount: 0,
    startsAt: range?.startsAt || null,
    endsAt: range?.endsAt || null,
    usageLimit: null,
    perUserLimit: 1,
    isActive: true,
    promotionLink: linkUrl,
    bestEffort: true,
  };
}

/** Khuyến mãi từ JSON API: object có title + ngày bắt đầu/kết thúc */
function promotionsFromJson(entries) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const tk = keys.find((k) => /^(title|name|tieude)$/i.test(k) && typeof o[k] === 'string');
      const sk = keys.find((k) => /(start|from|begin)/i.test(k) && typeof o[k] === 'string' && parseDate(o[k]));
      const ek = keys.find((k) => /(end|to|expire)/i.test(k) && typeof o[k] === 'string' && parseDate(o[k]));
      if (tk && (sk || ek)) {
        const img = keys.find((k) => /(image|img|thumb|banner)/i.test(k) && typeof o[k] === 'string');
        const slug = keys.find((k) => /(slug|url|link)/i.test(k) && typeof o[k] === 'string');
        out.push({
          title: o[tk],
          imageUrl: img ? o[img] : null,
          linkUrl: slug ? (o[slug].startsWith('http') ? o[slug] : `${BASE}/khuyen-mai/${o[slug].replace(/^\/+/, '')}`) : null,
          startsAt: sk ? parseDate(o[sk]).iso : null,
          endsAt: ek ? parseDate(o[ek]).iso : null,
        });
      }
    }
    Object.values(o).forEach(walk);
  };
  entries.forEach((e) => walk(e.body));
  return out;
}

async function scrapePromotions(context, globalJson) {
  const page = await context.newPage();
  const cards = [];

  for (const listUrl of [`${BASE}/khuyen-mai/`, `${BASE}/`]) {
    log('Crawl khuyến mãi:', listUrl);
    await gotoSafe(page, listUrl);
    for (let i = 0; i < 30; i++) { // bấm "Xem thêm" đến hết
      const btn = page.getByText(/xem thêm|load more/i).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click().catch(() => {});
      await sleep(900);
    }
    await autoScroll(page, 12);
    cards.push(
      ...(await page.$$eval('a[href*="/khuyen-mai/"]', (as) =>
        as.map((a) => ({
          href: a.href.split('?')[0].split('#')[0],
          title: (a.querySelector('img')?.alt || a.getAttribute('title') || a.innerText || '').trim(),
          img: a.querySelector('img')?.src || null,
        }))
      ))
    );
  }
  const uniq = [...new Map(cards.filter((c) => /\/khuyen-mai\/[^/]+/.test(c.href)).map((c) => [c.href, c])).values()];
  log(`  -> ${uniq.length} khuyến mãi`);

  const promotions = [];
  const vouchers = [];
  for (let i = 0; i < uniq.length; i++) {
    const c = uniq[i];
    let range = null, title = c.title, img = c.img, contentText = null, voucher = null;
    try {
      await gotoSafe(page, c.href);
      await expandContent(page);
      const d = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.innerText?.trim(),
        og: document.querySelector('meta[property="og:image"]')?.content,
        body: (document.querySelector('article, main') || document.body).innerText,
      }));
      title = d.h1 || title;
      img = img || d.og;
      contentText = d.body.slice(0, 8000);
      range = parseRange(d.body);
      voucher = extractVoucherFromText(title, d.body, range, c.href);
    } catch (_) {}
    promotions.push({
      title, imageUrl: img, linkUrl: c.href,
      description: contentText, // nội dung chi tiết/điều kiện áp dụng
      startsAt: range?.startsAt || null, endsAt: range?.endsAt || null,
      sortOrder: i,
      isActive: range?.endsAt ? new Date(range.endsAt + 'T23:59:59+07:00') >= new Date() : true,
      mediaYearHint: +(img || '').match(/\/media\/(20\d{2})\//)?.[1] || null,
    });
    if (voucher) vouchers.push(voucher);
    await politeWait();
  }
  await page.close();

  // Bổ sung từ JSON API (khuyến mãi mà DOM không có / thiếu ngày)
  for (const j of promotionsFromJson(globalJson)) {
    const hit = promotions.find((p) => slugify(p.title) === slugify(j.title));
    if (hit) { hit.startsAt = hit.startsAt || j.startsAt; hit.endsAt = hit.endsAt || j.endsAt; hit.imageUrl = hit.imageUrl || j.imageUrl; }
    else promotions.push({ ...j, description: null, sortOrder: promotions.length, isActive: true, mediaYearHint: +(j.imageUrl || '').match(/\/media\/(20\d{2})\//)?.[1] || null });
  }
  return { promotions, vouchers };
}

// ===================== 2b. BẮP NƯỚC (Concession) =====================
const FOOD_SRC = '(combo|bắp|bỏng|popcorn|nước|coke|pepsi|sprite|fanta|snack|trà|cà phê|cafe|hộp|bánh|kẹo|\\bly\\b)';
const FOOD_RE = new RegExp(FOOD_SRC, 'i');

/** "89.000đ" | 89000 | "89K" -> 89000 (VND, Int) */
function parseVnd(v) {
  if (typeof v === 'number') return v >= 1000 ? Math.round(v) : null;
  const s = String(v || '');
  let m = s.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,7})/);
  if (m) return +m[1].replace(/[.,]/g, '');
  m = s.match(/\b(\d{2,3})\s?k\b/i);
  return m ? +m[1] * 1000 : null;
}

function mapConcessionCategory(name) {
  if (/combo|\bset\b/i.test(name)) return 'COMBO';
  if (/bắp|bỏng|popcorn/i.test(name)) return 'POPCORN';
  if (/nước|coke|pepsi|sprite|fanta|trà|cà phê|cafe|drink|\bly\b/i.test(name)) return 'DRINK';
  return 'SNACK';
}

/** Tìm thẻ sản phẩm (ảnh + tên + giá) trên trang hiện tại: leaf-most element có giá & từ khoá đồ ăn */
async function extractConcessionCards(page) {
  const cards = await page.evaluate((foodSrc) => {
    const FOOD = new RegExp(foodSrc, 'i');
    const PRICE = /(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*(?:đ|₫|vnđ|vnd)\b/i;
    const PRICEK = /\b(\d{2,3})\s?k\b/i;
    const els = [...document.querySelectorAll('article,li,div,a')].filter((e) => {
      const t = (e.innerText || '').trim();
      return t.length >= 8 && t.length <= 400 && (PRICE.test(t) || PRICEK.test(t)) && FOOD.test(t) && e.querySelector('img');
    });
    const leaf = els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
    return leaf.map((e) => {
      const lines = e.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      const isPrice = (l) => PRICE.test(l) || PRICEK.test(l);
      const name = lines.find((l) => !isPrice(l) && l.length > 2) || null;
      const priceLine = lines.find(isPrice) || '';
      return {
        name,
        description: lines.filter((l) => l !== name && !isPrice(l)).join(' ') || null,
        priceText: priceLine,
        imageUrl: e.querySelector('img')?.src || null,
      };
    });
  }, FOOD_SRC);
  return cards
    .map((c) => ({ ...c, price: parseVnd(c.priceText), sourceUrl: page.url() }))
    .filter((c) => c.name && c.price && FOOD_RE.test(`${c.name} ${c.description || ''}`));
}

/** Bắp nước từ JSON API: object có tên (khớp từ khoá đồ ăn) + giá */
function concessionsFromJson(entries) {
  const out = [];
  const walk = (o, url) => {
    if (!o || typeof o !== 'object') return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const nk = keys.find((k) => /^(name|title|displayname|itemname|ten)$/i.test(k) && typeof o[k] === 'string');
      const pk = keys.find((k) => /(price|gia|amount)/i.test(k) && (typeof o[k] === 'number' || typeof o[k] === 'string'));
      if (nk && pk && FOOD_RE.test(o[nk])) {
        const price = parseVnd(o[pk]);
        if (price) {
          const ik = keys.find((k) => /(image|img|thumb|photo|poster)/i.test(k) && typeof o[k] === 'string');
          const dk = keys.find((k) => /(desc|content|mota|detail)/i.test(k) && typeof o[k] === 'string');
          out.push({ name: o[nk].trim(), price, imageUrl: ik ? o[ik] : null, description: dk ? o[dk].trim() : null, sourceUrl: url });
        }
      }
    }
    Object.values(o).forEach((v) => walk(v, url));
  };
  entries.forEach((e) => walk(e.body, e.url));
  return out;
}

/** Gộp: món có ở >=60% rạp (hoặc ở trang chung) -> cấp cụm (cinemaExternalId=null); còn lại giữ theo rạp */
function consolidateConcessions(general, perCinema, cinemaCount) {
  const key = (c) => `${slugify(c.name)}|${c.price}`;
  const chainLevel = new Map();
  for (const c of general) chainLevel.set(key(c), { ...c, cinemaExternalId: null });

  const groups = new Map();
  for (const c of perCinema) {
    const k = key(c);
    if (!groups.has(k)) groups.set(k, { rows: [], cinemas: new Set() });
    groups.get(k).rows.push(c);
    groups.get(k).cinemas.add(c.cinemaExternalId);
  }
  const perRows = [];
  for (const [k, g] of groups) {
    if (chainLevel.has(k)) continue;
    if (cinemaCount && g.cinemas.size / cinemaCount >= 0.6) chainLevel.set(k, { ...g.rows[0], cinemaExternalId: null });
    else perRows.push(...g.rows);
  }
  return [...chainLevel.values(), ...perRows].map((c, i) => ({
    chainCode: CHAIN_CODE,
    cinemaExternalId: c.cinemaExternalId ?? null,
    name: c.name,
    description: c.description || null,
    category: mapConcessionCategory(c.name),
    imageUrl: c.imageUrl || null,
    price: c.price,
    isActive: true,
    sortOrder: i,
    sourceUrl: c.sourceUrl || null,
  }));
}

/** Tìm trang bắp nước công khai từ menu trang chủ rồi cào thẻ sản phẩm */
async function scrapeGeneralConcessions(context) {
  const page = await context.newPage();
  await gotoSafe(page, `${BASE}/`);
  const links = await page.$$eval('a[href]', (as) =>
    as.map((a) => ({ href: a.href.split('#')[0], text: (a.innerText || a.title || '').trim() }))
  );
  const cand = [...new Set(
    links
      .filter((l) => l.href.startsWith(BASE) && (/(bắp|nước|combo|f&b|fnb|ăn uống|food)/i.test(l.text) || /(bap-nuoc|combo|fnb|food|an-uong)/i.test(l.href)))
      .map((l) => l.href)
  )].slice(0, 6);
  log(`Trang bắp nước công khai tìm thấy: ${cand.length}`, cand);

  const rows = [];
  for (const u of cand) {
    await gotoSafe(page, u);
    await expandContent(page);
    await autoScroll(page, 6);
    rows.push(...(await extractConcessionCards(page).catch(() => [])));
    await politeWait();
  }
  await page.close();
  return rows;
}

// ===================== 3. GOM LINK PHIM =====================
async function collectMovieLinks(context) {
  const links = new Map();
  const page = await context.newPage();
  captureJson(page, 'list');

  for (const lp of MOVIE_LISTS) {
    log('Mở trang danh sách phim:', lp.url);
    await gotoSafe(page, lp.url);

    if (lp.tag === 'trang-chu') {
      for (const label of ['Đang chiếu', 'Sắp chiếu', 'Phim IMAX']) {
        try {
          await page.getByText(label, { exact: true }).first().click({ timeout: 3000 });
          await sleep(1500);
          await autoScroll(page, 5);
        } catch (_) {}
      }
    }
    for (let i = 0; i < 30; i++) {
      const btn = page.getByText(/xem thêm|load more/i).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click().catch(() => {});
      await sleep(1000);
    }
    await autoScroll(page);

    const found = await page.$$eval('a[href*="/phim/"], a[href*="/dat-ve/"]', (as) =>
      as.map((a) => ({ href: a.href, title: (a.getAttribute('title') || a.querySelector('img')?.alt || a.textContent || '').trim() }))
    );
    for (const f of found) {
      const url = f.href.split('?')[0].split('#')[0];
      if (!links.has(url)) links.set(url, { url, title: f.title, sources: new Set() });
      links.get(url).sources.add(lp.tag);
    }
    log(`  -> tổng link phim: ${links.size}`);
    await politeWait();
  }
  await page.close();
  return [...links.values()];
}

// ===================== 4. LỊCH CHIẾU (Showtime) trên trang chi tiết phim =====================
/** Click tab ngày dd/mm bằng DOM click (kể cả khi tab nằm ngoài vùng carousel đang hiển thị). */
async function clickDateTab(page, ddmm) {
  return page.evaluate((d) => {
    const re = new RegExp('(^|\\s)' + d.replace('/', '\\/') + '\\s*$');
    const cands = [...document.querySelectorAll('div,button,li,a,span')].filter((e) => {
      const t = (e.innerText || '').trim();
      return t.length < 30 && re.test(t);
    });
    const leaf = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
    if (!leaf.length) return false;
    leaf[0].click();
    return true;
  }, ddmm);
}

/** Đọc 1 thẻ <select> có option khớp regex -> {idx, options[]} (dropdown "Toàn quốc" / "Tất cả rạp") */
async function readSelect(page, re) {
  return page.evaluate((src) => {
    const r = new RegExp(src, 'i');
    const selects = [...document.querySelectorAll('select')];
    const idx = selects.findIndex((sel) => [...sel.options].some((o) => r.test(o.textContent)));
    if (idx === -1) return null;
    return { idx, options: [...selects[idx].options].map((o) => o.textContent.trim()).filter(Boolean) };
  }, re.source);
}

async function selectOpt(page, idx, label) {
  await page.locator('select').nth(idx).selectOption({ label }, { timeout: 3000 });
  await sleep(900);
}

let warnedNoSelect = false;

async function scrapeShowtimes(page, movie, cinemaIndex) {
  const results = new Map();
  const now = new Date();
  const SECTION_STOP = ['Giới thiệu', 'Hỗ trợ', 'Phim khác'];

  // Duyệt tất cả tab ngày với bộ lọc (tỉnh/rạp) hiện tại
  const harvest = async (regionLabel) => {
    const t0 = await page.evaluate(() => document.body.innerText);
    const dates = [...new Set(sliceSection(t0, 'Lịch chiếu', SECTION_STOP).filter((l) => /^\d{1,2}\/\d{1,2}$/.test(l)))];
    for (const ddmm of dates) {
      const [dd, mm] = ddmm.split('/').map(Number);
      await clickDateTab(page, ddmm);
      await sleep(900);
      const text = await page.evaluate(() => document.body.innerText);
      const lines = sliceSection(text, 'Lịch chiếu', SECTION_STOP);
      const year = inferYear(dd, mm, now);

      for (const s of parseShowtimeLines(lines)) {
        const start = vnToUtcIso(year, mm, dd, s.hour, s.minute);
        const end = movie.durationMin ? new Date(new Date(start).getTime() + movie.durationMin * 60000).toISOString() : null;
        const cin = cinemaIndex.get(norm(s.cinemaName).replace(/galaxy( cinema)?/g, '').trim());
        const cinemaExternalId = cin?.externalId || `name:${slugify(s.cinemaName)}`;
        // dedupKey theo schema: sha1(chain:cinema:movie:auditorium:startTimeUTC); Galaxy không công khai phòng chiếu
        const dedupKey = sha1([CHAIN_CODE, cinemaExternalId, movie.slug, 'default', start].join(':'));
        if (results.has(dedupKey)) continue;
        results.set(dedupKey, {
          dedupKey,
          movieSlug: movie.slug,
          cinemaExternalId,
          cinemaName: s.cinemaName,
          auditoriumName: null,
          startTime: start,
          endTime: end,
          format: mapScreenFormat(s.formatLine),
          language: extractLanguage(s.formatLine),
          formatRaw: s.formatLine,
          status: 'SCHEDULED',
          seatSource: 'MOCK',
          lastSyncedAt: new Date().toISOString(),
        });
      }
    }
  };

  await harvest('Toàn quốc'); // mặc định: Toàn quốc + Tất cả rạp

  if (REGION_SWEEP) {
    const region = await readSelect(page, /toàn quốc/);
    if (!region) {
      if (!warnedNoSelect) { log('  ! không thấy <select> chọn tỉnh/thành -> chỉ lấy "Toàn quốc"'); warnedNoSelect = true; }
    } else {
      for (const r of region.options.filter((o) => !/toàn quốc/i.test(o))) {
        try { await selectOpt(page, region.idx, r); } catch (_) { continue; }
        await harvest(r);
        if (CINEMA_SWEEP) {
          const cs = await readSelect(page, /tất cả rạp/);
          if (cs) {
            for (const c of cs.options.filter((o) => !/tất cả rạp/i.test(o))) {
              try { await selectOpt(page, cs.idx, c); } catch (_) { continue; }
              await harvest(`${r} / ${c}`);
            }
          }
        }
      }
    }
  }
  return [...results.values()];
}

// ===================== 5. CHI TIẾT PHIM =====================
async function scrapeMovie(context, item, cinemaIndex) {
  const page = await context.newPage();
  const blobs = captureJson(page);
  await gotoSafe(page, item.url);
  await expandContent(page);

  blobs.push(
    ...(await page.evaluate(() => {
      const out = [];
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) try { out.push(JSON.parse(nd.textContent)); } catch (_) {}
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try { out.push(JSON.parse(s.textContent)); } catch (_) {}
      });
      return out;
    }))
  );

  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const meta = (p) => q(`meta[property="${p}"]`)?.content || q(`meta[name="${p}"]`)?.content || null;
    const title = q('h1')?.innerText?.trim() || meta('og:title');
    const iframe = [...document.querySelectorAll('iframe')].map((i) => i.src).find((s) => /youtube|youtu\.be/.test(s));
    const ytLink = [...document.querySelectorAll('a[href*="youtube"],a[href*="youtu.be"]')].map((a) => a.href)[0];
    // Poster: ảnh có alt chứa tên phim (không nằm trong link /dat-ve/ của phim khác)
    const imgs = [...document.querySelectorAll('img')].filter((i) => /cdn\.galaxycine\.vn\/media/.test(i.src) && !i.closest('a[href*="/dat-ve/"]'));
    const poster = imgs.find((i) => title && (i.alt || '').toLowerCase().includes(title.toLowerCase().slice(0, 12)))?.src || null;
    return {
      title,
      description: meta('og:description') || meta('description'),
      ogImage: meta('og:image'),
      poster,
      gallery: [...new Set(imgs.map((i) => i.src))],
      trailer: iframe || ytLink || null,
      text: document.body.innerText,
    };
  });

  const text = dom.text || '';
  const SECTIONS = ['Nhà sản xuất', 'Thể loại', 'Đạo diễn', 'Diễn viên', 'Nội dung phim', 'Lịch chiếu'];
  const others = (l) => SECTIONS.filter((x) => norm(x) !== norm(l));

  const paragraphs = sliceSection(text, 'Nội dung phim', ['Lịch chiếu']);
  const synopsis = paragraphs.length ? paragraphs.join('\n') : dom.description;
  const genres = sliceSection(text, 'Thể loại', others('Thể loại'));
  const directors = sliceSection(text, 'Đạo diễn', others('Đạo diễn'));
  const actors = sliceSection(text, 'Diễn viên', others('Diễn viên'));

  const ratingM = text.match(/(\d{1,2}(?:[.,]\d)?)\s*\((\d+)\s*votes?\)/i);
  const score = ratingM ? parseFloat(ratingM[1].replace(',', '.')) : null;
  const votes = ratingM ? +ratingM[2] : null;

  const durM = text.match(/(\d{2,3})\s*(?:phút|min)/i);
  const durationMin = durM ? +durM[1] : null;

  const release =
    findReleaseDate(blobs) ||
    parseDate(extractField(text, ['Khởi chiếu', 'Ngày khởi chiếu', 'Ngày chiếu', 'Release'])) ||
    parseDate((synopsis || '').match(/khởi chiếu[^\d]{0,20}(\d{1,2}[.\/-]\d{1,2}[.\/-]20\d{2})/i)?.[1]) ||
    null;

  // Tiêu đề dạng "English Title/ Tên Việt" -> tách originalTitle
  let title = dom.title || item.title;
  let originalTitle = null;
  if (title && title.includes('/')) {
    const [a, ...b] = title.split('/');
    originalTitle = a.trim();
    title = b.join('/').trim() || title;
  }

  const slug = item.url.split('/').filter(Boolean).pop();
  const posterUrl = dom.poster || dom.ogImage || null;
  const backdropUrl = dom.ogImage && dom.ogImage !== posterUrl ? dom.ogImage : null;

  // Trạng thái: theo tab danh sách; sắp chiếu nếu ngày chiếu ở tương lai
  const inNow = item.sources.has('dang-chieu') || item.sources.has('imax');
  let status = inNow ? 'NOW_SHOWING' : 'COMING_SOON';
  if (release && new Date(release.iso) > new Date() && !inNow) status = 'COMING_SOON';

  const movie = {
    slug,
    title,
    originalTitle,
    synopsis,
    durationMin,
    releaseDate: release?.iso || null,
    ageRating: mapAgeRating(extractField(text, ['Phân loại', 'Giới hạn độ tuổi']) || text.slice(0, 1500)),
    status,
    posterUrl,
    backdropUrl,
    trailerUrl: dom.trailer || findYoutube(blobs),
    language: extractField(text, ['Ngôn ngữ']),
    country: extractField(text, ['Quốc gia', 'Xuất xứ']),
    // ratingAvg theo thang 5 của CineHub (Galaxy chấm thang 10) + giữ điểm gốc
    ratingAvg: score !== null ? Math.round((score / 2) * 100) / 100 : 0,
    ratingCount: votes ?? 0,
    sourceScore: score,
    sourceScoreScale: 10,
    producers: sliceSection(text, 'Nhà sản xuất', others('Nhà sản xuất')),
    genres,
    directors,
    actors,
    _releaseYear: release?.year || null,
    _posterYearHint: +(posterUrl || '').match(/\/media\/(20\d{2})\//)?.[1] || null,
    _sources: [...item.sources],
  };

  const showtimes = await scrapeShowtimes(page, movie, cinemaIndex).catch((e) => {
    log('  ! lỗi lịch chiếu:', e.message);
    return [];
  });

  const sourceRow = {
    movieSlug: slug,
    chainCode: CHAIN_CODE,
    externalId: findInternalId(blobs, slug) || slug,
    url: item.url,
    lastSyncedAt: new Date().toISOString(),
  };

  const metadata = {
    // movie_metadata (MongoDB)
    slug,
    sources: [{ chain: CHAIN_CODE, externalId: sourceRow.externalId, url: item.url, syncedAt: sourceRow.lastSyncedAt }],
    gallery: dom.gallery.filter((u) => u !== posterUrl),
    tags: genres,
    extra: { descriptionParagraphs: paragraphs, descriptionMeta: dom.description, producers: movie.producers },
  };

  fs.writeFileSync(path.join(RAW_DIR, `detail_${slug}.json`), JSON.stringify(blobs, null, 2));
  await page.close();
  return { movie, showtimes, sourceRow, metadata };
}

// ===================== GỘP VỚI DỮ LIỆU CŨ (tích luỹ qua nhiều lần chạy) =====================
const nonNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
function mergeBy(prevArr = [], nextArr = [], keyFn) {
  const m = new Map(prevArr.map((x) => [keyFn(x), x]));
  for (const n of nextArr) { const k = keyFn(n); m.set(k, m.has(k) ? { ...m.get(k), ...nonNull(n) } : n); }
  return [...m.values()];
}

function buildOutput(scraped, cinemas, logoUrl, promotions, concessions = [], vouchers = []) {
  const keep = scraped =>
    m._releaseYear ? m._releaseYear === TARGET_YEAR : KEEP_UNKNOWN && m._posterYearHint === TARGET_YEAR
  );
  const strip = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_')));

  const movies = keep.map(({ movie }) => { const { genres, directors, actors, producers, ...rest } = strip(movie); return rest; });
  const genreMap = new Map(), personMap = new Map(), movieGenres = [], movieCredits = [];
  for (const { movie } of keep) {
    for (const g of movie.genres) { const slug = slugify(g); genreMap.set(slug, { slug, name: g }); movieGenres.push({ movieSlug: movie.slug, genreSlug: slug }); }
    movie.directors.forEach((n, i) => { personMap.set(n, { fullName: n, photoUrl: null }); movieCredits.push({ movieSlug: movie.slug, personName: n, role: 'DIRECTOR', billingOrder: i, characterName: null }); });
    movie.actors.forEach((n, i) => { personMap.set(n, { fullName: n, photoUrl: null }); movieCredits.push({ movieSlug: movie.slug, personName: n, role: 'ACTOR', billingOrder: i, characterName: null }); });
  }
  const showtimes = keep.flatMap((k) => k.showtimes);

  // Rạp chỉ thấy trong lịch chiếu (trang rạp lỗi/thiếu) -> tạo bản ghi tối thiểu để không mất rạp nào
  const known = new Set(cinemas.map((c) => c.externalId));
  const cinemaAll = [...cinemas];
  for (const st of showtimes) {
    if (!known.has(st.cinemaExternalId)) {
      known.add(st.cinemaExternalId);
      cinemaAll.push({ chainCode: CHAIN_CODE, externalId: st.cinemaExternalId, name: st.cinemaName, address: null, provinceCode: null, provinceName: null,
        districtName: null, latitude: null, longitude: null, phone: null, timezone: 'Asia/Ho_Chi_Minh', isActive: true, url: null, priceTables: null, discoveredFrom: 'showtime' });
    }
  }

  const provinceMap = new Map(), districtMap = new Map();
  for (const c of cinemaAll) {
    if (c.provinceCode) provinceMap.set(c.provinceCode, { code: c.provinceCode, name: c.provinceName });
    if (c.provinceCode && c.districtName) districtMap.set(`${c.provinceCode}|${c.districtName}`, { provinceCode: c.provinceCode, name: c.districtName });
  }

  return {
    meta: { source: BASE, crawledAt: new Date().toISOString(), targetYear: TARGET_YEAR, note: 'Tham chiếu bằng khoá tự nhiên (slug, externalId, code); Core cấp UUID khi upsert.' },
    cinemaChain: { code: CHAIN_CODE, name: 'Galaxy Cinema', logoUrl, websiteUrl: BASE, isActive: true },
    provinces: [...provinceMap.values()],
    districts: [...districtMap.values()],
    cinemas: cinemaAll,
    genres: [...genreMap.values()],
    persons: [...personMap.values()],
    movies,
    movieGenres,
    movieCredits,
    movieSources: keep.map((k) => k.sourceRow),
    showtimes,
    promotions,
    vouchers,
    concessions,
    movieMetadata: keep.map((k) => k.metadata),
  };
}

function mergeOutputs(prev, next) {
  if (!prev) return next;
  const out = { ...next };
  out.cinemaChain = { ...prev.cinemaChain, ...nonNull(next.cinemaChain) };
  out.provinces = mergeBy(prev.provinces, next.provinces, (x) => x.code);
  out.districts = mergeBy(prev.districts, next.districts, (x) => `${x.provinceCode}|${x.name}`);
  out.cinemas = mergeBy(prev.cinemas, next.cinemas, (x) => x.externalId);
  out.genres = mergeBy(prev.genres, next.genres, (x) => x.slug);
  out.persons = mergeBy(prev.persons, next.persons, (x) => x.fullName);
  out.movies = mergeBy(prev.movies, next.movies, (x) => x.slug);
  out.movieGenres = mergeBy(prev.movieGenres, next.movieGenres, (x) => `${x.movieSlug}|${x.genreSlug}`);
  out.movieCredits = mergeBy(prev.movieCredits, next.movieCredits, (x) => `${x.movieSlug}|${x.personName}|${x.role}`);
  out.movieSources = mergeBy(prev.movieSources, next.movieSources, (x) => `${x.movieSlug}|${x.chainCode}`);
  out.showtimes = mergeBy(prev.showtimes, next.showtimes, (x) => x.dedupKey); // giữ cả suất đã chiếu từ các lần chạy trước
  out.promotions = mergeBy(prev.promotions, next.promotions, (x) => x.linkUrl || x.title);
  out.vouchers = mergeBy(prev.vouchers, next.vouchers, (x) => x.code);
  out.concessions = mergeBy(prev.concessions, next.concessions, (x) => `${x.cinemaExternalId || 'ALL'}|${slugify(x.name)}`);
  out.movieMetadata = mergeBy(prev.movieMetadata, next.movieMetadata, (x) => x.slug);
  return out;
}

function finalizeAndSave(out) {
  const nowMs = Date.now();
  // Chỉ giữ suất chiếu thuộc năm 2026; suất đã qua -> FINISHED
  out.showtimes = out.showtimes
    .filter((s) => new Date(s.startTime).getUTCFullYear() === TARGET_YEAR || new Date(s.startTime).getFullYear() === TARGET_YEAR)
    .map((s) => (new Date(s.startTime).getTime() < nowMs && s.status === 'SCHEDULED' ? { ...s, status: 'FINISHED' } : s))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  out.movies.sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_cinemas.csv'), toCSV(out.cinemas.map(({ priceTables, ...r }) => r)));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_movies_2026.csv'), toCSV(out.movies));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_showtimes_2026.csv'), toCSV(out.showtimes));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_promotions_2026.csv'), toCSV((out.promotions || []).map(({ description, ...r }) => r)));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_concessions.csv'), toCSV(out.concessions || []));
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_vouchers.csv'), toCSV(out.vouchers || []));
  return out;
}

// ===================== MAIN =====================
async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const prev = !FRESH && fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : null;
  if (prev) log(`Gộp với file cũ: ${prev.movies?.length || 0} phim, ${prev.showtimes?.length || 0} suất chiếu`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  const scraped = [];
  let cinemas = [], logoUrl = null, promotions = [], vouchers = [], cinemaCards = [], generalCards = [];

  // Bắt mọi JSON API liên quan bắp nước / khuyến mãi trên toàn bộ các trang đã mở
  const globalJson = [];
  context.on('response', async (res) => {
    try {
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      if (!/galaxycine/i.test(res.url())) return;
      const body = await res.json();
      const str = JSON.stringify(body);
      if (str.length < 3_000_000 && /(combo|bắp|popcorn|concession|food|khuyến mãi|promotion|voucher|ưu đãi)/i.test(str)) {
        globalJson.push({ url: res.url(), body });
      }
    } catch (_) {}
  });

  const computeConcessions = () => {
    const general = [...generalCards, ...concessionsFromJson(globalJson)];
    return consolidateConcessions(general, cinemaCards, cinemas.length);
  };
  const save = () => finalizeAndSave(mergeOutputs(prev, buildOutput(scraped, cinemas, logoUrl, promotions, computeConcessions(), vouchers)));
  process.on('SIGINT', () => { log('Ctrl+C -> lưu dữ liệu đã cào...'); try { save(); } catch (_) {} process.exit(0); });

  try {
    // --- Rạp toàn quốc, tỉnh, quận ---
    ({ cinemas, logoUrl, cinemaCards } = await scrapeCinemas(context));
    const cinemaIndex = new Map(cinemas.map((c) => [norm(c.name).replace(/galaxy( cinema)?/g, '').trim(), c]));

    // --- Khuyến mãi ---
    const promo = await scrapePromotions(context, globalJson);
    promotions = promo.promotions.filter((p) =>
      [p.startsAt, p.endsAt].some((d) => d && +d.slice(0, 4) === TARGET_YEAR) || p.mediaYearHint === TARGET_YEAR || (PROMO_ALL && !p.startsAt && !p.endsAt)
    );
    const keepLinks = new Set(promotions.map((p) => p.linkUrl));
    vouchers = promo.vouchers.filter((v) => keepLinks.has(v.promotionLink));

    // --- Bắp nước: trang công khai (nếu có) + thẻ trên trang rạp + JSON API ---
    generalCards = await scrapeGeneralConcessions(context);

    // --- Phim + lịch chiếu toàn quốc (chạy song song CONCURRENCY phim) ---
    let links = await collectMovieLinks(context);
    if (links.length > MAX_MOVIES) links = links.slice(0, MAX_MOVIES);
    log(`Tìm thấy ${links.length} phim. Cào chi tiết + lịch chiếu toàn quốc (song song ${CONCURRENCY})...`);

    let next = 0, done = 0;
    const worker = async () => {
      while (next < links.length) {
        const i = next++;
        log(`[${i + 1}/${links.length}] ${links[i].url}`);
        try { scraped.push(await scrapeMovie(context, links[i], cinemaIndex)); } catch (e) { log('  ! lỗi:', e.message); }
        if (++done % 10 === 0) save(); // checkpoint
        await politeWait();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

    const out = save();
    log('================ KẾT QUẢ ================');
    log(`Phim ${TARGET_YEAR}: ${out.movies.length} | Suất chiếu ${TARGET_YEAR}: ${out.showtimes.length}`);
    log(`Rạp: ${out.cinemas.length} | Tỉnh/thành: ${out.provinces.length} | Quận/huyện: ${out.districts.length}`);
    log(`Thể loại: ${out.genres.length} | Người: ${out.persons.length} | Khuyến mãi: ${out.promotions.length} | Voucher: ${out.vouchers.length} | Bắp nước: ${out.concessions.length}`);
    log('File: galaxycine_2026.json + CSV (cinemas, movies, showtimes, promotions, concessions, vouchers)');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseRange, parseVnd, mapConcessionCategory, consolidateConcessions, concessionsFromJson, promotionsFromJson, extractVoucherFromText, mergeOutputs, buildOutput, finalizeAndSave, parseDate, parseAddress, parseShowtimeLines, mapScreenFormat, extractLanguage, mapAgeRating, slugify, sliceSection, vnToUtcIso, inferYear };