/**
 * crawl-moveek-galaxy-2026.js
 * ------------------------------------------------------------------
 * Crawl dữ liệu Galaxy Cinema TOÀN QUỐC trên Moveek (https://moveek.com), năm 2026.
 * Xuất JSON theo schema CineHub (CinemaChain, Province, District, Cinema, Genre,
 * Person, Movie, MovieGenre, MovieCredit, MovieSource, Showtime, movie_metadata).
 *
 * Luồng chạy:
 *  1. /he-thong-rap/galaxy-cinema/  -> danh sách tất cả rạp Galaxy (+ tỉnh/thành, rạp ngừng hoạt động)
 *  2. /rap/<slug>                   -> chi tiết rạp (địa chỉ, khu vực, ảnh)
 *  3. Mỗi rạp x mỗi ngày            -> lịch chiếu (phim, định dạng, giờ)
 *  4. /dang-chieu, /sap-chieu, /chieu-som, /phim-viet-nam, /phim-thang-MM-2026
 *                                   -> gom thêm phim ra mắt năm 2026
 *  5. /phim/<slug>                  -> chi tiết phim (ngày khởi chiếu, thể loại, diễn viên, đạo diễn...)
 *  6. Lọc: phim khởi chiếu 2026 HOẶC có suất chiếu Galaxy trong 2026; suất chiếu chỉ năm 2026.
 *
 * Cài đặt & chạy:
 *   npm init -y && npm i playwright && npx playwright install chromium
 *   node crawl-moveek-galaxy-2026.js
 *
 * Biến môi trường:
 *   FULL_YEAR=true          quét 01/01/2026 -> 31/12/2026 (mặc định: hôm nay -> +13 ngày)
 *   DATE_FROM=2026-10-01    tuỳ chỉnh khoảng ngày (YYYY-MM-DD), luôn bị kẹp trong năm 2026
 *   DATE_TO=2026-10-31
 *   MAX_CINEMAS=3           chỉ chạy N rạp đầu (để thử)
 *   MAX_MOVIES=10           chỉ cào chi tiết N phim đầu (để thử)
 *   HEADLESS=false          xem trình duyệt chạy (hữu ích nếu bị chặn bot)
 *
 * LƯU Ý: Moveek thường chỉ giữ lịch chiếu cho hôm nay và vài tuần tới. Ngày đã qua
 * trong năm 2026 thường không còn dữ liệu -> kết quả rỗng là bình thường.
 * Hãy kiểm tra robots.txt / điều khoản của Moveek và giữ tốc độ chậm.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== CẤU HÌNH =====================
const BASE = 'https://moveek.com';
const CHAIN_PAGE = `${BASE}/he-thong-rap/galaxy-cinema/`;
const CHAIN_CODE = 'GALAXY';
const TARGET_YEAR = 2026;
const HEADLESS = process.env.HEADLESS !== 'false';
const FULL_YEAR = process.env.FULL_YEAR === 'true';
const MAX_CINEMAS = process.env.MAX_CINEMAS ? +process.env.MAX_CINEMAS : Infinity;
const MAX_MOVIES = process.env.MAX_MOVIES ? +process.env.MAX_MOVIES : Infinity;
const DELAY_MS = [1200, 2500];
const OUT_DIR = __dirname;
const RAW_DIR = path.join(OUT_DIR, 'raw');

const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // ngày hiện tại theo giờ VN
const clampYear = (d) => (d < `${TARGET_YEAR}-01-01` ? `${TARGET_YEAR}-01-01` : d > `${TARGET_YEAR}-12-31` ? `${TARGET_YEAR}-12-31` : d);
const DATE_FROM = clampYear(process.env.DATE_FROM || (FULL_YEAR ? `${TARGET_YEAR}-01-01` : TODAY));
const DATE_TO = clampYear(process.env.DATE_TO || (FULL_YEAR ? `${TARGET_YEAR}-12-31` : addDays(TODAY, 13)));

const MOVIE_LISTS = [
  { url: `${BASE}/dang-chieu/`, tag: 'dang-chieu' },
  { url: `${BASE}/sap-chieu/`, tag: 'sap-chieu' },
  { url: `${BASE}/chieu-som/`, tag: 'chieu-som' },
  { url: `${BASE}/phim-viet-nam/`, tag: 'phim-viet-nam' },
  ...Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return { url: `${BASE}/phim-thang-${mm}-${TARGET_YEAR}/`, tag: `thang-${mm}` };
  }),
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

function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  let m = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (m) return { iso: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, year: +m[3] };
  m = str.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, year: +m[1] };
  return null;
}

function extractField(text, labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(label + '\\s*[:：]?\\s*\\n?\\s*([^\\n]{1,300})', 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function sliceSection(text, startLabel, stopLabels = []) {
  const lines = text.split('\n').map((l) => l.trim());
  const start = norm(startLabel);
  const stops = stopLabels.map(norm);
  const isLabel = (l, lab) => norm(l) === lab || norm(l).startsWith(lab + ':');
  const i = lines.findIndex((l) => isLabel(l, start));
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (stops.some((s) => isLabel(lines[j], s))) break;
    if (lines[j]) out.push(lines[j]);
  }
  return out;
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

async function gotoSafe(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (_) {
    log('  ! timeout, dùng nội dung đã load:', url);
  }
  await sleep(800);
}

// Lưu vài response XHR + snapshot HTML để bạn xem/tinh chỉnh (giới hạn số lượng)
let rawSaved = 0;
function captureNetwork(page, tag) {
  page.on('response', async (res) => {
    try {
      const t = res.request().resourceType();
      if ((t !== 'xhr' && t !== 'fetch') || rawSaved >= 40 || !/moveek\.com/.test(res.url())) return;
      const body = (await res.text()).slice(0, 200000);
      rawSaved++;
      fs.writeFileSync(path.join(RAW_DIR, `xhr_${tag}_${rawSaved}.txt`), `${res.url()}\n\n${body}`);
    } catch (_) {}
  });
}
let htmlSaved = 0;
async function snapshotHtml(page, name) {
  if (htmlSaved >= 4) return;
  htmlSaved++;
  fs.writeFileSync(path.join(RAW_DIR, `snapshot_${name}.html`), await page.content());
}

// ===================== MAPPING =====================
const PROVINCE_CODES = { 'hồ chí minh': 'HCM', 'hà nội': 'HN', 'đà nẵng': 'DN', 'cần thơ': 'CT', 'hải phòng': 'HP' };

function provinceFromName(name, regionSlug) {
  if (!name) return null;
  const clean = name.replace(/^(tp\.?|thành phố|tỉnh)\s+/i, '').trim();
  const code = PROVINCE_CODES[clean.toLowerCase()] || (regionSlug ? regionSlug.toUpperCase().replace(/-/g, '_') : slugify(clean).toUpperCase().replace(/-/g, '_'));
  return { code, name: clean };
}

/** Lấy quận/huyện nếu địa chỉ còn cấp này (địa chỉ mới sau sáp nhập có thể không có). */
function parseDistrict(address) {
  if (!address) return null;
  const m = address.match(/(?:\b|,\s*)(Quận|Q\.|Huyện|H\.|Thị xã|TX\.)\s*([^,]+)/i);
  if (!m) return null;
  const kind = /^q/i.test(m[1]) ? 'Quận' : /^h/i.test(m[1]) ? 'Huyện' : 'Thị xã';
  return `${kind} ${m[2].trim()}`;
}

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
  for (let i = 0; i < 4; i++) s = s.replace(/^\s*(IMAX|2D|3D|4DX|SCREEN\s?X|\+|-|·)\s*/i, '');
  return s.trim() || null;
}

function mapAgeRating(s) {
  const m = String(s || '').toUpperCase().match(/\b(T13|T16|T18|P|K|C)\b/);
  return m ? m[1] : null;
}

function vnToUtcIso(dateIso, h, mi) {
  const p = (n) => String(n).padStart(2, '0');
  return new Date(`${dateIso}T${p(h)}:${p(mi)}:00+07:00`).toISOString();
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

// ===================== PARSER THUẦN (dễ test) =====================
/**
 * Parse trang /he-thong-rap/galaxy-cinema/.
 * Cấu trúc text: "<Tỉnh>" -> "N cụm rạp" -> (tên rạp, địa chỉ)*; sau đó "Ngừng hoạt động" -> (tên rạp, tỉnh)*.
 */
function parseCinemaListLines(lines, nameToHref) {
  const out = [];
  const seen = new Set();
  let province = null;
  let inactive = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\d+\s*cụm rạp$/i.test(l)) { province = lines[i - 1] || null; inactive = false; continue; }
    if (/^Ngừng hoạt động$/i.test(l)) { inactive = true; province = null; continue; }
    if (nameToHref[l] && !seen.has(l)) {
      seen.add(l);
      const next = lines[i + 1] && !nameToHref[lines[i + 1]] ? lines[i + 1] : null;
      out.push({
        name: l,
        url: nameToHref[l],
        externalId: nameToHref[l].split('/').filter(Boolean).pop(),
        address: inactive ? null : next,
        provinceName: inactive ? next : province,
        isActive: !inactive,
      });
    }
  }
  return out;
}

const FORMAT_RE = /^(IMAX|2D|3D|4DX|SCREEN\s?X|Standard|Digital)\b/i;
const TIME_RE = /^(\d{1,2}):(\d{2})(?!\d)/;

/** Parse text một ngày lịch chiếu của 1 rạp: tên phim -> định dạng -> các giờ chiếu. */
function parseDayLines(text, titleMap) {
  let lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const cut = lines.findIndex((l) => /^PHIM .*(SẮP CHIẾU|ĐANG CHIẾU)$/i.test(l) || /^CÔNG TY TNHH MONET/i.test(l));
  if (cut > 0) lines = lines.slice(0, cut);

  const out = [];
  let movie = null;
  let fmt = null;
  for (const l of lines) {
    if (titleMap[l]) { movie = { slug: titleMap[l], title: l, ageHint: null }; fmt = null; continue; }
    if (!movie) continue;
    const t = l.match(TIME_RE);
    if (t) {
      const range = l.match(/^(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
      out.push({
        movieSlug: movie.slug, movieTitle: movie.title, ageHint: movie.ageHint, formatLine: fmt,
        hour: +t[1], minute: +t[2],
        endHour: range ? +range[3] : null, endMinute: range ? +range[4] : null,
        rawLine: l,
      });
      continue;
    }
    if (/^(T13|T16|T18|P|K|C)$/.test(l)) { movie.ageHint = l; continue; }
    if (FORMAT_RE.test(l)) fmt = l;
  }
  return out;
}

// ===================== 1. DANH SÁCH + CHI TIẾT RẠP =====================
async function scrapeCinemas(context) {
  const page = await context.newPage();
  captureNetwork(page, 'chain');
  log('Danh sách rạp Galaxy:', CHAIN_PAGE);
  await gotoSafe(page, CHAIN_PAGE);

  const { text, links } = await page.evaluate(() => ({
    text: document.body.innerText,
    links: [...document.querySelectorAll('a[href*="/rap/"]')]
      .map((a) => ({ name: a.innerText.trim(), href: a.href.split('?')[0].split('#')[0] }))
      .filter((l) => l.name && /moveek\.com\/rap\/[^/]+$/i.test(l.href)),
  }));
  const nameToHref = Object.fromEntries(links.map((l) => [l.name, l.href]));
  let list = parseCinemaListLines(text.split('\n').map((l) => l.trim()).filter(Boolean), nameToHref);
  log(`  -> ${list.length} rạp (${list.filter((c) => c.isActive).length} đang hoạt động)`);
  if (list.length > MAX_CINEMAS) list = list.slice(0, MAX_CINEMAS);

  const cinemas = [];
  for (const c of list) {
    let detail = {};
    try {
      await gotoSafe(page, c.url);
      detail = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const region = document.querySelector('a[href*="/rap-khu-vuc/"]');
        const map = document.querySelector('a[href*="maps.google"]');
        const lines = document.body.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        const hi = lines.findIndex((l) => l === h1?.innerText?.trim());
        return {
          h1: h1?.innerText?.trim() || null,
          address: hi >= 0 ? lines[hi + 1] : null,
          regionName: region?.innerText?.trim() || null,
          regionSlug: region?.href?.split('/').filter(Boolean).pop() || null,
          mapUrl: map?.href || null,
          image: document.querySelector('meta[property="og:image"]')?.content || null,
        };
      });
    } catch (e) {
      log('  ! lỗi rạp', c.url, e.message);
    }
    const address = detail.address && detail.address.length > 8 && !/Lịch chiếu/i.test(detail.address) ? detail.address : c.address;
    const prov = provinceFromName(detail.regionName || c.provinceName, detail.regionSlug);
    cinemas.push({
      chainCode: CHAIN_CODE,
      externalId: c.externalId,
      name: c.name,
      address: address || c.address || null,
      provinceCode: prov?.code || null,
      provinceName: prov?.name || null,
      districtName: parseDistrict(address || c.address),
      latitude: null, // Moveek chỉ cung cấp liên kết Google Maps theo tên, không có toạ độ
      longitude: null,
      phone: null,
      timezone: 'Asia/Ho_Chi_Minh',
      isActive: c.isActive,
      url: c.url,
      mapUrl: detail.mapUrl || null,
      imageUrl: detail.image || null,
    });
    log('  rạp:', c.name, '|', prov?.name || '?', c.isActive ? '' : '(ngừng hoạt động)');
    await politeWait();
  }
  await page.close();
  return cinemas;
}

// ===================== 2. LỊCH CHIẾU =====================
async function clickDateTab(page, iso) {
  const [, mm, dd] = iso.split('-').map(Number);
  return page.evaluate(([d, m]) => {
    const re = new RegExp('(^|\\s)0?' + d + '\\/0?' + m + '\\s*$');
    const cands = [...document.querySelectorAll('a,button,li,div,span')].filter((e) => {
      const t = (e.innerText || '').trim();
      return t.length < 30 && re.test(t);
    });
    const leaf = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
    if (!leaf.length) return false;
    leaf[0].click();
    return true;
  }, [dd, mm]);
}

async function readDay(page) {
  return page.evaluate(() => {
    const titleMap = {};
    document.querySelectorAll('a[href*="/phim/"]').forEach((a) => {
      const m = a.href.match(/\/phim\/([^/?#]+)/);
      if (!m) return;
      for (const t of [a.innerText, a.getAttribute('title')]) if (t && t.trim()) titleMap[t.trim()] = m[1];
    });
    return { text: document.body.innerText, titleMap };
  });
}

let DAY_MODE = null; // 'param' (?date=YYYY-MM-DD) hoặc 'click' (bấm tab ngày) — tự phát hiện ở rạp đầu tiên

async function loadDay(page, cinema, iso, mode) {
  if (mode === 'param') {
    await gotoSafe(page, `${cinema.url}?date=${iso}`);
  } else {
    if (!page.url().startsWith(cinema.url)) await gotoSafe(page, cinema.url);
    await clickDateTab(page, iso);
    await sleep(1200);
  }
  return readDay(page);
}

async function detectDayMode(page, cinema) {
  const d0 = TODAY, d1 = addDays(TODAY, 1);
  const a = parseDayLines((await loadDay(page, cinema, d0, 'param')).text, (await readDay(page)).titleMap);
  await snapshotHtml(page, `${cinema.externalId}_${d0}`);
  const b = parseDayLines((await loadDay(page, cinema, d1, 'param')).text, (await readDay(page)).titleMap);
  const sig = (x) => x.map((s) => `${s.movieSlug}${s.hour}:${s.minute}`).join('|');
  const mode = sig(a) !== sig(b) || (!a.length && !b.length) ? 'param' : 'click';
  log(`  Phát hiện cách chọn ngày: ${mode} (${a.length} / ${b.length} suất hôm nay / ngày mai)`);
  if (!a.length && !b.length) log('  ! Không thấy suất nào — xem raw/snapshot_*.html để chỉnh parser nếu rạp này đang có phim.');
  return mode;
}

async function scrapeCinemaShowtimes(page, cinema) {
  const dates = [];
  for (let d = DATE_FROM; d <= DATE_TO; d = addDays(d, 1)) dates.push(d);
  const map = new Map();
  let i = 0, streak = 0, foundAny = false;

  while (i < dates.length) {
    const iso = dates[i];
    let items = [];
    try {
      const day = await loadDay(page, cinema, iso, DAY_MODE);
      items = parseDayLines(day.text, day.titleMap);
    } catch (e) {
      log('  ! lỗi ngày', iso, e.message);
    }

    for (const s of items) {
      const start = vnToUtcIso(iso, s.hour, s.minute);
      const end = s.endHour !== null ? vnToUtcIso(iso, s.endHour, s.endMinute) : null;
      // dedupKey theo schema: sha1(chain:cinema:movie:auditorium:startTimeUTC); Moveek không có phòng chiếu -> 'default'
      const dedupKey = sha1([CHAIN_CODE, cinema.externalId, s.movieSlug, 'default', start].join(':'));
      if (map.has(dedupKey)) continue;
      map.set(dedupKey, {
        dedupKey,
        movieSlug: s.movieSlug,
        movieTitle: s.movieTitle,
        cinemaExternalId: cinema.externalId,
        cinemaName: cinema.name,
        auditoriumName: null,
        showDate: iso,
        startTime: start,
        endTime: end,
        format: mapScreenFormat(s.formatLine),
        language: extractLanguage(s.formatLine),
        formatRaw: s.formatLine,
        ageHint: s.ageHint,
        status: 'SCHEDULED',
        seatSource: 'MOCK',
        source: 'moveek',
        lastSyncedAt: new Date().toISOString(),
      });
    }

    if (items.length) { streak = 0; foundAny = true; } else streak++;
    // Ngày đã qua mà 7 ngày liên tiếp trống -> nhảy thẳng tới hôm nay
    if (iso < TODAY && !foundAny && streak >= 7) {
      const j = dates.findIndex((d) => d >= TODAY);
      if (j === -1) break;
      i = j; streak = 0; continue;
    }
    if (iso >= TODAY && streak >= 14) break; // hết lịch chiếu đã công bố
    i++;
    await politeWait();
  }
  return [...map.values()];
}

// ===================== 3. GOM LINK PHIM =====================
async function collectMovieSlugs(context) {
  const page = await context.newPage();
  const found = new Map(); // slug -> Set(tag)
  for (const lp of MOVIE_LISTS) {
    log('Danh sách phim:', lp.url);
    let url = lp.url;
    for (let p = 0; p < 15 && url; p++) {
      await gotoSafe(page, url);
      await autoScroll(page, 6);
      const { slugs, next } = await page.evaluate(() => ({
        slugs: [...new Set([...document.querySelectorAll('a[href*="/phim/"]')].map((a) => a.href.match(/\/phim\/([^/?#]+)/)?.[1]).filter(Boolean))],
        next: document.querySelector('a[rel="next"], .pagination .next a, li.next a')?.href || null,
      }));
      for (const s of slugs) {
        if (!found.has(s)) found.set(s, new Set());
        found.get(s).add(lp.tag);
      }
      url = next && next !== url ? next : null;
      await politeWait();
    }
    log(`  -> tổng ${found.size} phim`);
  }
  await page.close();
  return found;
}

// ===================== 4. CHI TIẾT PHIM =====================
const PERSON_LABELS = /^(Khởi chiếu|Diễn viên|Đạo diễn|Thể loại|Thời lượng|Quốc gia|Nhà sản xuất|Kiểm duyệt|Ngôn ngữ|Nhà phát hành|Biên kịch)$/i;

async function scrapeMovie(context, slug, tags) {
  const page = await context.newPage();
  const url = `${BASE}/phim/${slug}/`;
  await gotoSafe(page, url);

  const dom = await page.evaluate((labelSrc) => {
    const LABELS = new RegExp(labelSrc, 'i');
    const q = (s) => document.querySelector(s);
    const meta = (p) => q(`meta[property="${p}"]`)?.content || q(`meta[name="${p}"]`)?.content || null;

    const labelEls = [...document.querySelectorAll('strong,b,dt,label,span,div,h6,small,p')].filter(
      (e) => e.children.length === 0 && LABELS.test((e.innerText || '').trim())
    );
    const peopleAfter = (re) => {
      const el = labelEls.find((e) => re.test(e.innerText.trim()));
      if (!el) return [];
      const start = el.nextSibling ? el : el.parentElement || el;
      const out = [];
      for (let n = start.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 1) {
          const first = (n.innerText || '').trim().split('\n')[0];
          if (LABELS.test(first)) break;
          const as = n.matches('a[href*="/nghe-sy/"]') ? [n] : [...n.querySelectorAll('a[href*="/nghe-sy/"]')];
          as.forEach((a) => out.push({ name: a.innerText.trim(), slug: a.href.split('/').filter(Boolean).pop() }));
        }
      }
      return out.filter((p) => p.name);
    };

    const ld = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { ld.push(JSON.parse(s.textContent)); } catch (_) {}
    });
    const yt = document.documentElement.outerHTML.match(/(?:https?:)?\/\/(?:www\.)?(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)[\w-]+/);

    return {
      h1: q('h1')?.innerText?.trim() || null,
      text: document.body.innerText,
      ogImage: meta('og:image'),
      ogDesc: meta('og:description'),
      actors: peopleAfter(/^Diễn viên$/i),
      directors: peopleAfter(/^Đạo diễn$/i),
      trailer: yt ? (yt[0].startsWith('//') ? 'https:' + yt[0] : yt[0]) : null,
      ld,
    };
  }, PERSON_LABELS.source);

  const text = dom.text || '';
  // JSON-LD (nếu trang có schema.org/Movie)
  const ldMovie = dom.ld.flat().find((o) => o && /Movie/i.test(o['@type'] || '')) || {};

  // Dòng giữa tiêu đề và "Thích/Khởi chiếu": thể loại, độ tuổi, thời lượng
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const hi = lines.findIndex((l) => l === dom.h1);
  const genres = [];
  let ageRating = null;
  let durationMin = null;
  if (hi >= 0) {
    for (let j = hi + 1; j < Math.min(lines.length, hi + 8); j++) {
      const l = lines[j];
      if (/^(Thích|Đánh giá|Trailer|Khởi chiếu)/i.test(l)) break;
      const dur = l.match(/^(\d{2,3})\s*phút$/i);
      if (dur) { durationMin = +dur[1]; continue; }
      const age = mapAgeRating(l.length <= 4 ? l : '');
      if (age) { ageRating = age; continue; }
      if (l.length < 40) l.split(/[,/]/).map((x) => x.trim()).filter(Boolean).forEach((g) => genres.push(g));
    }
  }
  (Array.isArray(ldMovie.genre) ? ldMovie.genre : ldMovie.genre ? [ldMovie.genre] : []).forEach((g) => !genres.includes(g) && genres.push(g));

  const release = parseDate(extractField(text, ['Khởi chiếu'])) || parseDate(ldMovie.datePublished || ldMovie.dateCreated || '');
  if (!durationMin) {
    const iso = String(ldMovie.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    durationMin = iso && (iso[1] || iso[2]) ? (+iso[1] || 0) * 60 + (+iso[2] || 0) : +(text.match(/(\d{2,3})\s*phút/i)?.[1] || 0) || null;
  }

  const synopsisLines = sliceSection(text, 'Nội dung', ['Diễn viên', 'Đạo diễn', 'Lịch chiếu', 'Đánh giá']).length
    ? sliceSection(text, 'Nội dung', ['Diễn viên', 'Đạo diễn', 'Lịch chiếu', 'Đánh giá'])
    : [];
  const synopsis =
    synopsisLines.join('\n') ||
    ldMovie.description ||
    (dom.ogDesc && !/moveek/i.test(dom.ogDesc) ? dom.ogDesc : null);

  const posterUrl = dom.ogImage && !/no-poster/.test(dom.ogImage) ? dom.ogImage : null;
  const ratingAvg = ldMovie.aggregateRating?.ratingValue ? +ldMovie.aggregateRating.ratingValue : null;

  const movie = {
    slug,
    title: dom.h1 || slug,
    originalTitle: null,
    synopsis,
    durationMin,
    releaseDate: release?.iso || null,
    ageRating: ageRating || mapAgeRating(extractField(text, ['Kiểm duyệt', 'Phân loại'])),
    status: 'COMING_SOON', // gán lại ở bước tổng hợp
    posterUrl,
    backdropUrl: null,
    trailerUrl: dom.trailer,
    language: extractField(text, ['Ngôn ngữ']),
    country: extractField(text, ['Quốc gia', 'Xuất xứ']),
    ratingAvg: ratingAvg ?? 0,
    ratingCount: ldMovie.aggregateRating?.ratingCount ? +ldMovie.aggregateRating.ratingCount : 0,
    genres,
    actors: dom.actors,
    directors: dom.directors,
    producers: [],
    _releaseYear: release?.year || null,
    _tags: [...(tags || [])],
    _sourceUrl: url,
  };
  await page.close();
  return movie;
}

// ===================== MAIN =====================
async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(RAW_DIR, { recursive: true });
  log(`Khoảng ngày lịch chiếu: ${DATE_FROM} -> ${DATE_TO} (hôm nay VN: ${TODAY})`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  try {
    // --- Rạp ---
    const cinemas = await scrapeCinemas(context);

    // --- Lịch chiếu từng rạp (bỏ qua rạp ngừng hoạt động) ---
    const page = await context.newPage();
    captureNetwork(page, 'cinema');
    const showtimes = [];
    const active = cinemas.filter((c) => c.isActive);
    for (let i = 0; i < active.length; i++) {
      const c = active[i];
      log(`[${i + 1}/${active.length}] Lịch chiếu: ${c.name}`);
      if (!DAY_MODE) DAY_MODE = await detectDayMode(page, c);
      try {
        const st = await scrapeCinemaShowtimes(page, c);
        log(`  -> ${st.length} suất`);
        showtimes.push(...st);
      } catch (e) {
        log('  ! lỗi:', e.message);
      }
      fs.writeFileSync(path.join(RAW_DIR, 'showtimes_checkpoint.json'), JSON.stringify(showtimes, null, 2));
    }
    await page.close();

    // --- Phim: hợp của (phim có suất Galaxy) và (phim trong các danh sách 2026) ---
    const listSlugs = await collectMovieSlugs(context);
    const showtimeSlugs = new Set(showtimes.map((s) => s.movieSlug));
    const allSlugs = new Map(listSlugs);
    for (const s of showtimeSlugs) if (!allSlugs.has(s)) allSlugs.set(s, new Set(['galaxy-showtime']));
    let slugList = [...allSlugs.keys()];
    if (slugList.length > MAX_MOVIES) slugList = slugList.slice(0, MAX_MOVIES);
    log(`Cào chi tiết ${slugList.length} phim...`);

    const scraped = [];
    for (let i = 0; i < slugList.length; i++) {
      log(`[${i + 1}/${slugList.length}] ${slugList[i]}`);
      try { scraped.push(await scrapeMovie(context, slugList[i], allSlugs.get(slugList[i]))); } catch (e) { log('  ! lỗi:', e.message); }
      await politeWait();
    }

    // --- Lọc năm 2026 & hoàn thiện ---
    const yearOf = (iso) => (iso ? +iso.slice(0, 4) : null);
    const keep = scraped.filter((m) => m._releaseYear === TARGET_YEAR || showtimeSlugs.has(m.slug));
    const keepSlugs = new Set(keep.map((m) => m.slug));
    const movieBySlug = new Map(keep.map((m) => [m.slug, m]));

    for (const m of keep) {
      const upcoming = m.releaseDate && m.releaseDate > TODAY;
      const showingNow = m._tags.includes('dang-chieu');
      m.status = showingNow ? 'NOW_SHOWING' : upcoming || m._tags.includes('sap-chieu') ? 'COMING_SOON' : showtimeSlugs.has(m.slug) ? 'NOW_SHOWING' : 'ENDED';
      if (!m.ageRating) m.ageRating = showtimes.find((s) => s.movieSlug === m.slug && s.ageHint)?.ageHint || null;
    }

    const finalShowtimes = showtimes
      .filter((s) => yearOf(s.showDate) === TARGET_YEAR && keepSlugs.has(s.movieSlug))
      .map((s) => {
        const dur = movieBySlug.get(s.movieSlug)?.durationMin;
        const { ageHint, ...rest } = s;
        return { ...rest, endTime: rest.endTime || (dur ? new Date(new Date(rest.startTime).getTime() + dur * 60000).toISOString() : null) };
      });

    const genreMap = new Map(), personMap = new Map();
    const movieGenres = [], movieCredits = [];
    for (const m of keep) {
      m.genres.forEach((g) => { const gs = slugify(g); genreMap.set(gs, { slug: gs, name: g }); movieGenres.push({ movieSlug: m.slug, genreSlug: gs }); });
      m.directors.forEach((p, i) => { personMap.set(p.slug, { slug: p.slug, fullName: p.name, photoUrl: null }); movieCredits.push({ movieSlug: m.slug, personSlug: p.slug, personName: p.name, role: 'DIRECTOR', billingOrder: i, characterName: null }); });
      m.actors.forEach((p, i) => { personMap.set(p.slug, { slug: p.slug, fullName: p.name, photoUrl: null }); movieCredits.push({ movieSlug: m.slug, personSlug: p.slug, personName: p.name, role: 'ACTOR', billingOrder: i, characterName: null }); });
    }

    const provinceMap = new Map(), districtMap = new Map();
    for (const c of cinemas) {
      if (c.provinceCode) provinceMap.set(c.provinceCode, { code: c.provinceCode, name: c.provinceName });
      if (c.provinceCode && c.districtName) districtMap.set(`${c.provinceCode}|${c.districtName}`, { provinceCode: c.provinceCode, name: c.districtName });
    }

    const movies = keep
      .map(({ genres, actors, directors, producers, ...m }) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))))
      .sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));

    const output = {
      meta: {
        source: BASE, chainPage: CHAIN_PAGE, crawledAt: new Date().toISOString(),
        targetYear: TARGET_YEAR, showtimeRange: { from: DATE_FROM, to: DATE_TO },
        note: 'Tham chiếu bằng khoá tự nhiên (slug, externalId, code); Core cấp UUID khi upsert.',
      },
      cinemaChain: { code: CHAIN_CODE, name: 'Galaxy Cinema', logoUrl: null, websiteUrl: 'https://www.galaxycine.vn', isActive: true },
      provinces: [...provinceMap.values()],
      districts: [...districtMap.values()],
      cinemas,
      genres: [...genreMap.values()],
      persons: [...personMap.values()],
      movies,
      movieGenres,
      movieCredits,
      movieSources: keep.map((m) => ({ movieSlug: m.slug, chainCode: CHAIN_CODE, externalId: m.slug, url: m._sourceUrl, sourceSite: 'moveek.com', lastSyncedAt: new Date().toISOString() })),
      showtimes: finalShowtimes,
      movieMetadata: keep.map((m) => ({ slug: m.slug, sources: [{ chain: CHAIN_CODE, externalId: m.slug, url: m._sourceUrl }], gallery: [], tags: m.genres, extra: {} })),
    };

    fs.writeFileSync(path.join(OUT_DIR, 'galaxy_moveek_2026.json'), JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxy_cinemas.csv'), toCSV(cinemas));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxy_movies_2026.csv'), toCSV(movies));
    fs.writeFileSync(path.join(OUT_DIR, 'galaxy_showtimes_2026.csv'), toCSV(finalShowtimes));

    log('================ KẾT QUẢ ================');
    log(`Rạp: ${cinemas.length} (hoạt động ${active.length}) | Tỉnh/thành: ${provinceMap.size} | Quận/huyện: ${districtMap.size}`);
    log(`Phim: ${movies.length} | Thể loại: ${genreMap.size} | Người: ${personMap.size} | Suất chiếu: ${finalShowtimes.length}`);
    log('File: galaxy_moveek_2026.json + 3 file CSV');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseCinemaListLines, parseDayLines, parseDistrict, provinceFromName, mapScreenFormat, extractLanguage, vnToUtcIso, parseDate, slugify, addDays };