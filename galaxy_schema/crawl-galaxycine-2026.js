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
 *   Promotion    : title, imageUrl, linkUrl, startsAt, endsAt, sortOrder, isActive
 *   movie_metadata (Mongo): gallery, tags, sourceScore...
 *
 * KHÔNG lấy được từ Galaxy (do CineHub tự sinh/mô phỏng hoặc phát sinh từ người dùng):
 *   Auditorium, Seat, ShowtimeSeat, TicketType, SeatType, ShowtimePrice (chỉ lấy
 *   được nếu site hiển thị -> xem cinema.priceTables), Concession, Voucher,
 *   User, Booking, Payment...
 *
 * Cài đặt & chạy:
 *   npm init -y && npm i playwright && npx playwright install chromium
 *   node crawl-galaxycine-2026.js
 *
 * Biến môi trường:
 *   HEADLESS=false      xem trình duyệt chạy
 *   KEEP_UNKNOWN=true   giữ phim không rõ ngày chiếu nếu poster nằm trong /media/2026/
 *   MAX_MOVIES=5        giới hạn số phim (để chạy thử)
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
  return { cinemas, logoUrl };
}

// ===================== 2. KHUYẾN MÃI (Promotion) =====================
async function scrapePromotions(context) {
  const page = await context.newPage();
  log('Crawl khuyến mãi:', `${BASE}/khuyen-mai/`);
  await gotoSafe(page, `${BASE}/khuyen-mai/`);
  await autoScroll(page, 10);

  const cards = await page.$$eval('a[href*="/khuyen-mai/"]', (as) =>
    as
      .map((a) => ({
        href: a.href.split('?')[0],
        title: (a.querySelector('img')?.alt || a.getAttribute('title') || a.innerText || '').trim(),
        img: a.querySelector('img')?.src || null,
      }))
      .filter((c) => /\/khuyen-mai\/[^/]+/.test(c.href))
  );
  const uniq = [...new Map(cards.map((c) => [c.href, c])).values()];
  log(`  -> ${uniq.length} khuyến mãi`);

  const promos = [];
  for (let i = 0; i < uniq.length; i++) {
    const c = uniq[i];
    let starts = null, ends = null, title = c.title, img = c.img;
    try {
      await gotoSafe(page, c.href);
      const d = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.innerText?.trim(),
        og: document.querySelector('meta[property="og:image"]')?.content,
        text: document.body.innerText,
      }));
      title = d.h1 || title;
      img = img || d.og;
      const range = d.text.match(/(\d{1,2}[\/.]\d{1,2}[\/.]20\d{2})\s*(?:-|–|đến|->)\s*(\d{1,2}[\/.]\d{1,2}[\/.]20\d{2})/i);
      if (range) { starts = parseDate(range[1])?.iso; ends = parseDate(range[2])?.iso; }
    } catch (_) {}
    promos.push({
      title, imageUrl: img, linkUrl: c.href,
      startsAt: starts, endsAt: ends,
      sortOrder: i, isActive: true,
      mediaYearHint: +(img || '').match(/\/media\/(20\d{2})\//)?.[1] || null,
    });
    await politeWait();
  }
  await page.close();
  return promos;
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

    const found = await page.$$eval('a[href*="/dat-ve/"]', (as) =>
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

async function scrapeShowtimes(page, movie, cinemaIndex) {
  const text0 = await page.evaluate(() => document.body.innerText);
  const section0 = sliceSection(text0, 'Lịch chiếu', ['Giới thiệu', 'Hỗ trợ', 'Phim khác']);
  const dates = [...new Set(section0.filter((l) => /^\d{1,2}\/\d{1,2}$/.test(l)))];
  const now = new Date();
  const results = new Map();

  for (const ddmm of dates) {
    const [dd, mm] = ddmm.split('/').map(Number);
    await clickDateTab(page, ddmm);
    await sleep(1000);
    const text = await page.evaluate(() => document.body.innerText);
    const lines = sliceSection(text, 'Lịch chiếu', ['Giới thiệu', 'Hỗ trợ', 'Phim khác']);
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

// ===================== MAIN =====================
async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  try {
    // --- Rạp, tỉnh, quận ---
    const { cinemas, logoUrl } = await scrapeCinemas(context);
    const cinemaIndex = new Map(cinemas.map((c) => [norm(c.name).replace(/galaxy( cinema)?/g, '').trim(), c]));

    // --- Khuyến mãi ---
    const promotionsAll = await scrapePromotions(context);
    const promotions = promotionsAll.filter((p) =>
      [p.startsAt, p.endsAt].some((d) => d && +d.slice(0, 4) === TARGET_YEAR) || p.mediaYearHint === TARGET_YEAR
    );

    // --- Phim + lịch chiếu ---
    let links = await collectMovieLinks(context);
    if (links.length > MAX_MOVIES) links = links.slice(0, MAX_MOVIES);
    log(`Tìm thấy ${links.length} phim. Cào chi tiết + lịch chiếu...`);

    const scraped = [];
    for (let i = 0; i < links.length; i++) {
      log(`[${i + 1}/${links.length}] ${links[i].url}`);
      try { scraped.push(await scrapeMovie(context, links[i], cinemaIndex)); } catch (e) { log('  ! lỗi:', e.message); }
      await politeWait();
    }

    // --- Lọc năm 2026 ---
    const keep = scraped.filter(({ movie: m }) =>
      m._releaseYear ? m._releaseYear === TARGET_YEAR : KEEP_UNKNOWN && m._posterYearHint === TARGET_YEAR
    );

    const strip = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_')));
    const movies = keep.map(({ movie }) => {
      const { genres, directors, actors, producers, ...rest } = strip(movie);
      return rest;
    }).sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));

    const genreMap = new Map();
    const personMap = new Map();
    const movieGenres = [];
    const movieCredits = [];
    for (const { movie } of keep) {
      for (const g of movie.genres) {
        const slug = slugify(g);
        genreMap.set(slug, { slug, name: g });
        movieGenres.push({ movieSlug: movie.slug, genreSlug: slug });
      }
      movie.directors.forEach((n, i) => {
        personMap.set(n, { fullName: n, photoUrl: null });
        movieCredits.push({ movieSlug: movie.slug, personName: n, role: 'DIRECTOR', billingOrder: i, characterName: null });
      });
      movie.actors.forEach((n, i) => {
        personMap.set(n, { fullName: n, photoUrl: null });
        movieCredits.push({ movieSlug: movie.slug, personName: n, role: 'ACTOR', billingOrder: i, characterName: null });
      });
    }

    const showtimes = keep.flatMap((k) => k.showtimes);

    // Tỉnh / quận chuẩn hoá từ các rạp
    const provinceMap = new Map();
    const districtMap = new Map();
    for (const c of cinemas) {
      if (c.provinceCode) provinceMap.set(c.provinceCode, { code: c.provinceCode, name: c.provinceName });
      if (c.provinceCode && c.districtName) districtMap.set(`${c.provinceCode}|${c.districtName}`, { provinceCode: c.provinceCode, name: c.districtName });
    }

    const output = {
      meta: { source: BASE, crawledAt: new Date().toISOString(), targetYear: TARGET_YEAR, note: 'Tham chiếu bằng khoá tự nhiên (slug, externalId, code); Core cấp UUID khi upsert.' },
      cinemaChain: { code: CHAIN_CODE, name: 'Galaxy Cinema', logoUrl, websiteUrl: BASE, isActive: true },
      provinces: [...provinceMap.values()],
      districts: [...districtMap.values()],
      cinemas,
      genres: [...genreMap.values()],
      persons: [...personMap.values()],
      movies,
      movieGenres,
      movieCredits,
      movieSources: keep.map((k) => k.sourceRow),
      showtimes,
      promotions,
      movieMetadata: keep.map((k) => k.metadata), // collection movie_metadata (MongoDB)
    };

    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_2026.json'), JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_movies_2026.csv'), toCSV(movies));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_showtimes_2026.csv'), toCSV(showtimes));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_all_movies_debug.json'), JSON.stringify(scraped.map((s) => s.movie), null, 2));

    log('================ KẾT QUẢ ================');
    log(`Phim cào được: ${scraped.length} | năm ${TARGET_YEAR}: ${movies.length}`);
    log(`Rạp: ${cinemas.length} | Tỉnh: ${provinceMap.size} | Quận: ${districtMap.size}`);
    log(`Thể loại: ${genreMap.size} | Người: ${personMap.size} | Suất chiếu: ${showtimes.length} | Khuyến mãi: ${promotions.length}`);
    log('File: galaxycine_2026.json, galaxycine_movies_2026.csv, galaxycine_showtimes_2026.csv');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseDate, parseAddress, parseShowtimeLines, mapScreenFormat, extractLanguage, mapAgeRating, slugify, sliceSection, vnToUtcIso, inferYear };