/**
 * crawl-galaxycine-2026.js
 * ------------------------------------------------------------------
 * Crawl dữ liệu Galaxy Cinema (https://www.galaxycine.vn/) cho năm 2026,
 * xuất JSON theo đúng các bảng/trường trong schema CineHub (Prisma).
 *
 * Bảng/trường lấy được từ Galaxy:
 *   CinemaChain  : code=GALAXY, name, logoUrl, websiteUrl, isActive
 *   Province     : đủ 34 tỉnh/thành (code, name, type CITY|PROVINCE, cinemaCount) - đã bỏ cấp quận/huyện
 *   Ward         : provinceCode, name, type (PHUONG | XA | DAC_KHU) lấy từ địa chỉ rạp
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

/** Tìm object phim trong JSON API: object có 1 giá trị chuỗi kết thúc bằng slug */
function findMovieObject(blobs, slug) {
  let found = null;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return;
    if (!Array.isArray(o) && Object.keys(o).length >= 4 &&
        Object.values(o).some((v) => typeof v === 'string' && v.split('/').filter(Boolean).pop() === slug)) { found = o; return; }
    Object.values(o).forEach(walk);
  };
  blobs.forEach(walk);
  return found;
}

function pickString(obj, keyRe) {
  if (!obj) return null;
  const c = deepCollect(obj, (k, v) => keyRe.test(k) && typeof v === 'string' && v.trim());
  return c.length ? c[0].value.trim() : null;
}

/** "PT1H45M" | "1h45" | "105 phút" | 105 -> 105 (phút) */
function parseDuration(v) {
  let d = null;
  if (typeof v === 'number') d = v;
  else {
    const s = String(v || '');
    let m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
    if (m && (m[1] || m[2])) d = (+m[1] || 0) * 60 + (+m[2] || 0);
    else if ((m = s.match(/(\d{1,2})\s*(?:giờ|h)\s*(\d{1,2})?/i))) d = +m[1] * 60 + (+m[2] || 0);
    else if ((m = s.match(/(\d{2,3})\s*(?:phút|min(?:s|utes)?\b|')/i))) d = +m[1];
    else if ((m = s.match(/^\s*(\d{2,3})\s*$/))) d = +m[1];
  }
  return d && d >= 20 && d <= 400 ? Math.round(d) : null;
}

function findDuration(headText, movieObj) {
  const fromText = parseDuration(headText);
  if (fromText) return fromText;
  if (!movieObj) return null;
  for (const c of deepCollect(movieObj, (k, v) => /(duration|runtime|thoi.?luong|movielength|filmlength)/i.test(k) && ['number', 'string'].includes(typeof v))) {
    const d = parseDuration(c.value);
    if (d) return d;
  }
  return null;
}

/** Phân loại độ tuổi: P, K, T13, T16, T18, C */
function findAgeRating(labelValue, headText, movieObj) {
  const fromStr = (str) => {
    const t = String(str || '');
    let m = t.match(/\b(T13|T16|T18)\b/i);
    if (m) return m[1].toUpperCase();
    if ((m = t.match(/\(\s*(P|K|C)\s*\)/))) return m[1];
    if ((m = t.match(/(?:cấm|dưới|từ|đủ)[^\d\n]{0,25}(13|16|18)\s*tuổi/i))) return 'T' + m[1];
    if (/mọi lứa tuổi|mọi độ tuổi|mọi đối tượng/i.test(t)) return 'P';
    const line = t.split('\n').map((l) => l.trim()).find((l) => /^(P|K|C)(\s*[-:–].*)?$/.test(l));
    return line ? line[0] : null;
  };
  let r = fromStr(labelValue) || fromStr(headText);
  if (r) return r;
  if (movieObj) {
    for (const c of deepCollect(movieObj, (k, v) => /(rating|age|classification|phan.?loai|censor|restrict)/i.test(k) && ['number', 'string'].includes(typeof v))) {
      if (typeof c.value === 'number') { if ([13, 16, 18].includes(c.value)) return 'T' + c.value; if (c.value === 0) return 'P'; continue; }
      if ((r = fromStr(c.value))) return r;
      if (/^(13|16|18)$/.test(c.value)) return 'T' + c.value;
    }
  }
  return null;
}

function toYoutubeUrl(v) {
  const s = String(v || '').replace(/\\u002F|\\\//gi, '/');
  let m = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/i);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  if (/^[\w-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  if (/^https?:\/\/\S+\.(mp4|m3u8)(\?\S*)?$/i.test(s)) return s;
  return null;
}

function findTrailerInObject(obj) {
  if (!obj) return null;
  for (const c of deepCollect(obj, (k, v) => /(trailer|video|youtube)/i.test(k) && typeof v === 'string')) {
    const u = toYoutubeUrl(c.value);
    if (u) return u;
  }
  return null;
}

/** Trailer thường chỉ xuất hiện sau khi bấm nút "Trailer" (modal YouTube) */
async function clickTrailer(page) {
  try {
    const btn = page.getByText(/trailer/i).first();
    if (!(await btn.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    await btn.click({ timeout: 2500 });
    await sleep(1800);
    const src = await page.$eval('iframe[src*="youtube"], iframe[src*="youtu.be"], video source, video', (e) => e.src || e.currentSrc || null).catch(() => null);
    const html = await page.content();
    await page.keyboard.press('Escape').catch(() => {});
    return toYoutubeUrl(src) || toYoutubeUrl(html);
  } catch (_) {
    return null;
  }
}

const COUNTRY_LANG = [
  ['viet nam', 'Tiếng Việt'], ['thai lan', 'Tiếng Thái'], ['han quoc', 'Tiếng Hàn'], ['nhat ban', 'Tiếng Nhật'], ['trung quoc', 'Tiếng Trung'],
  ['dai loan', 'Tiếng Trung'], ['hong kong', 'Tiếng Quảng Đông'], ['my', 'Tiếng Anh'], ['hoa ky', 'Tiếng Anh'], ['anh', 'Tiếng Anh'],
  ['uc', 'Tiếng Anh'], ['canada', 'Tiếng Anh'], ['phap', 'Tiếng Pháp'], ['duc', 'Tiếng Đức'], ['tay ban nha', 'Tiếng Tây Ban Nha'],
  ['an do', 'Tiếng Hindi'], ['indonesia', 'Tiếng Indonesia'], ['philippines', 'Tiếng Philippines'], ['nga', 'Tiếng Nga'], ['italy', 'Tiếng Ý'],
];
/** Ngôn ngữ gốc suy ra từ quốc gia (chỉ dùng khi trang không ghi) */
function inferLanguageFromCountry(country) {
  for (const part of String(country || '').split(/[\/,;&-]/)) {
    const f = fold(part);
    const hit = COUNTRY_LANG.find(([k]) => f === k);
    if (hit) return hit[1];
  }
  return null;
}

// ---------- Hành chính Việt Nam sau sắp xếp 2025: 34 tỉnh/thành, BỎ cấp quận/huyện ----------
const fold = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// [code, tên chuẩn, loại, [tên gọi khác / tên tỉnh cũ đã sáp nhập]]
const PROVINCES = [
  ['HN', 'Hà Nội', 'CITY', []],
  ['HCM', 'Thành phố Hồ Chí Minh', 'CITY', ['tp hcm', 'tphcm', 'tp ho chi minh', 'sai gon', 'binh duong', 'ba ria vung tau', 'ba ria', 'vung tau']],
  ['HP', 'Hải Phòng', 'CITY', ['hai duong']],
  ['DN', 'Đà Nẵng', 'CITY', ['quang nam']],
  ['CT', 'Cần Thơ', 'CITY', ['soc trang', 'hau giang']],
  ['HUE', 'Huế', 'CITY', ['thua thien hue']],
  ['TUYEN_QUANG', 'Tuyên Quang', 'PROVINCE', ['ha giang']],
  ['LAO_CAI', 'Lào Cai', 'PROVINCE', ['yen bai']],
  ['THAI_NGUYEN', 'Thái Nguyên', 'PROVINCE', ['bac kan']],
  ['PHU_THO', 'Phú Thọ', 'PROVINCE', ['vinh phuc', 'hoa binh']],
  ['BAC_NINH', 'Bắc Ninh', 'PROVINCE', ['bac giang']],
  ['HUNG_YEN', 'Hưng Yên', 'PROVINCE', ['thai binh']],
  ['NINH_BINH', 'Ninh Bình', 'PROVINCE', ['ha nam', 'nam dinh']],
  ['QUANG_NINH', 'Quảng Ninh', 'PROVINCE', []],
  ['CAO_BANG', 'Cao Bằng', 'PROVINCE', []],
  ['LANG_SON', 'Lạng Sơn', 'PROVINCE', []],
  ['LAI_CHAU', 'Lai Châu', 'PROVINCE', []],
  ['DIEN_BIEN', 'Điện Biên', 'PROVINCE', []],
  ['SON_LA', 'Sơn La', 'PROVINCE', []],
  ['THANH_HOA', 'Thanh Hóa', 'PROVINCE', []],
  ['NGHE_AN', 'Nghệ An', 'PROVINCE', []],
  ['HA_TINH', 'Hà Tĩnh', 'PROVINCE', []],
  ['QUANG_TRI', 'Quảng Trị', 'PROVINCE', ['quang binh']],
  ['QUANG_NGAI', 'Quảng Ngãi', 'PROVINCE', ['kon tum']],
  ['GIA_LAI', 'Gia Lai', 'PROVINCE', ['binh dinh']],
  ['KHANH_HOA', 'Khánh Hòa', 'PROVINCE', ['ninh thuan']],
  ['LAM_DONG', 'Lâm Đồng', 'PROVINCE', ['dak nong', 'dak nông', 'binh thuan']],
  ['DAK_LAK', 'Đắk Lắk', 'PROVINCE', ['phu yen']],
  ['DONG_NAI', 'Đồng Nai', 'PROVINCE', ['binh phuoc']],
  ['TAY_NINH', 'Tây Ninh', 'PROVINCE', ['long an']],
  ['VINH_LONG', 'Vĩnh Long', 'PROVINCE', ['ben tre', 'tra vinh']],
  ['DONG_THAP', 'Đồng Tháp', 'PROVINCE', ['tien giang']],
  ['CA_MAU', 'Cà Mau', 'PROVINCE', ['bac lieu']],
  ['AN_GIANG', 'An Giang', 'PROVINCE', ['kien giang']],
];
const PROVINCE_BY_CODE = Object.fromEntries(PROVINCES.map(([code, name, type]) => [code, { code, name, type }]));
const PROVINCE_ALIASES = PROVINCES.flatMap(([code, name, , al]) =>
  [...new Set([fold(name), fold(name.replace(/^Thành phố /, '')), ...al.map(fold)])].map((alias) => ({ alias, code }))
);
// Tên thành phố/địa danh trong tên rạp -> tỉnh/thành mới (chỉ dùng khi địa chỉ thiếu)
const NAME_HINTS = [
  ['long xuyen', 'AN_GIANG'], ['rach gia', 'AN_GIANG'], ['phu quoc', 'AN_GIANG'], ['nha trang', 'KHANH_HOA'], ['cam ranh', 'KHANH_HOA'],
  ['phan rang', 'KHANH_HOA'], ['vinh', 'NGHE_AN'], ['buon ma thuot', 'DAK_LAK'], ['tuy hoa', 'DAK_LAK'], ['bien hoa', 'DONG_NAI'],
  ['da lat', 'LAM_DONG'], ['phan thiet', 'LAM_DONG'], ['pleiku', 'GIA_LAI'], ['quy nhon', 'GIA_LAI'], ['my tho', 'DONG_THAP'],
  ['cao lanh', 'DONG_THAP'], ['sa dec', 'DONG_THAP'], ['thu dau mot', 'HCM'], ['di an', 'HCM'], ['thuan an', 'HCM'],
  ['my phuoc', 'HCM'], ['tan uyen', 'HCM'], ['ha long', 'QUANG_NINH'], ['cam pha', 'QUANG_NINH'], ['viet tri', 'PHU_THO'],
  ['phu ly', 'NINH_BINH'], ['dong hoi', 'QUANG_TRI'], ['dong ha', 'QUANG_TRI'], ['tan an', 'TAY_NINH'], ['dong xoai', 'DONG_NAI'],
  ['thu duc', 'HCM'], ['nguyen du', 'HCM'], ['nguyen trai', 'HCM'], ['tan binh', 'HCM'], ['kinh duong vuong', 'HCM'], ['quang trung', 'HCM'],
  ['huynh tan phat', 'HCM'], ['nguyen van qua', 'HCM'], ['trung chanh', 'HCM'], ['mipec', 'HN'], ['long bien', 'HN'],
];

function matchBest(foldedText, list) {
  let best = null;
  for (const { alias, code } of list) {
    const re = new RegExp(`(?:^| )${alias}(?= |$)`, 'g');
    let m;
    while ((m = re.exec(foldedText))) {
      const end = m.index + m[0].length;
      if (!best || end > best.end || (end === best.end && alias.length > best.len)) best = { code, end, len: alias.length };
    }
  }
  return best ? PROVINCE_BY_CODE[best.code] : null;
}

/** Tách tỉnh/thành + phường/xã từ địa chỉ. Địa chỉ cũ (Quận/Huyện) vẫn được quy về tỉnh/thành mới. */
function parseAddress(address, cinemaName) {
  const segs = String(address || '').split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/^(việt nam|vietnam)$/i.test(x));

  // Tỉnh/thành nằm ở cuối địa chỉ -> chỉ xét 2 đoạn cuối (tránh nhầm với tên đường như "Nguyễn Huệ")
  let province = segs.length ? matchBest(fold(segs.slice(-2).join(' ')), PROVINCE_ALIASES) : null;
  if (!province && cinemaName) {
    const n = fold(cinemaName);
    province =
      matchBest(n, PROVINCE_ALIASES) ||
      matchBest(n, NAME_HINTS.map(([alias, code]) => ({ alias, code })));
  }

  // Phường / Xã / Đặc khu (không lấy Quận, Huyện)
  let ward = null, wardIdx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    let m = segs[i].match(/^(phường|xã|đặc khu|thị trấn)\s+(.+)$/i);
    let kind = m && m[1].toLowerCase();
    if (!m) { m = segs[i].match(/^(p|x|tt)\.\s*(.+)$/i); kind = m && ({ p: 'phường', x: 'xã', tt: 'thị trấn' })[m[1].toLowerCase()]; }
    if (m) {
      const type = { 'phường': 'PHUONG', 'xã': 'XA', 'đặc khu': 'DAC_KHU', 'thị trấn': 'THI_TRAN' }[kind];
      const label = { PHUONG: 'Phường', XA: 'Xã', DAC_KHU: 'Đặc khu', THI_TRAN: 'Thị trấn' }[type];
      ward = { name: `${label} ${m[2].trim()}`, type };
      wardIdx = i;
      break;
    }
  }
  const street = (wardIdx >= 0 ? segs.slice(0, wardIdx) : segs.filter((x) => !/^(quận|huyện|thị xã|thành phố|tp\.?|tỉnh)\b/i.test(x))).join(', ') || null;
  return { province, ward, street };
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

// ===================== 1. CINEMA CHAIN + RẠP TOÀN QUỐC (tỉnh/thành + phường/xã) =====================
const isCinemaLink = (u) => /\/rap-gia-ve\/[^/]+\/?$/.test(u) && !/premium-hall/.test(u);
const cinemaIdFromUrl = (u) => u.split('/').filter(Boolean).pop();

/** Dựng bản ghi rạp theo schema (Province + Ward, không có quận/huyện) */
function makeCinemaRow({ externalId, name, address = null, phone = null, latitude = null, longitude = null, url = null, priceTables = null, discoveredFrom = null }) {
  const { province, ward, street } = parseAddress(address, name);
  return {
    chainCode: CHAIN_CODE,
    externalId,
    name,
    address,
    streetAddress: street,
    provinceCode: province?.code || null,
    provinceName: province?.name || null,
    wardName: ward?.name || null,
    wardType: ward?.type || null,
    latitude,
    longitude,
    phone,
    timezone: 'Asia/Ho_Chi_Minh',
    isActive: true,
    url,
    priceTables,
    discoveredFrom,
  };
}

/** Rạp từ JSON API: object có name "Galaxy ..." + address */
function cinemasFromJson(entries) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const nk = keys.find((k) => /^(name|title|cinemaname|tenrap|ten)$/i.test(k) && typeof o[k] === 'string' && /^galaxy\b/i.test(o[k].trim()));
      const ak = keys.find((k) => /(address|diachi|dia_chi)/i.test(k) && typeof o[k] === 'string' && o[k].trim());
      if (nk && ak) {
        const ik = keys.find((k) => /^(id|cinemaid|uuid|slug)$/i.test(k) && ['string', 'number'].includes(typeof o[k]));
        const lat = keys.find((k) => /^(lat|latitude)$/i.test(k));
        const lng = keys.find((k) => /^(lng|lon|long|longitude)$/i.test(k));
        const ph = keys.find((k) => /(phone|tel|hotline)/i.test(k) && typeof o[k] === 'string');
        out.push({
          externalId: ik ? String(o[ik]) : null,
          name: o[nk].trim(),
          address: o[ak].trim(),
          latitude: lat && !isNaN(+o[lat]) ? +o[lat] : null,
          longitude: lng && !isNaN(+o[lng]) ? +o[lng] : null,
          phone: ph ? o[ph].trim() : null,
        });
      }
    }
    Object.values(o).forEach(walk);
  };
  entries.forEach((e) => walk(e.body));
  return out;
}

/** Mở trang danh sách rạp và quét LẦN LƯỢT từng tỉnh/thành (select hoặc tab/nút) để lấy hết link rạp toàn quốc */
async function discoverCinemaLinks(context) {
  const page = await context.newPage();
  const links = new Set();
  let logoUrl = null;
  const add = async () => {
    const hrefs = await page.$$eval('a[href*="/rap-gia-ve/"]', (as) => as.map((a) => a.href.split('?')[0].split('#')[0])).catch(() => []);
    hrefs.filter(isCinemaLink).forEach((u) => links.add(u));
  };
  const uiLabels = [...new Set(PROVINCE_ALIASES.map((a) => a.alias).concat(['tp hcm', 'tp ha noi']))];
  const foldSrc = fold.toString();

  for (const url of [`${BASE}/rap-gia-ve/`, `${BASE}/`]) {
    log('Tìm rạp toàn quốc tại:', url);
    await gotoSafe(page, url);
    await autoScroll(page, 6);
    await add();
    if (!logoUrl) logoUrl = await page.$eval('header img, img[alt*="logo" i]', (i) => i.src).catch(() => null);

    // Cách 1: <select> chọn tỉnh/thành -> duyệt từng option
    const selects = await page.evaluate(() =>
      [...document.querySelectorAll('select')].map((sel, i) => ({ i, options: [...sel.options].map((o) => o.textContent.trim()).filter(Boolean) }))
    );
    for (const sel of selects) {
      if (!sel.options.some((o) => matchBest(fold(o), PROVINCE_ALIASES))) continue;
      for (const o of sel.options) {
        try {
          await page.locator('select').nth(sel.i).selectOption({ label: o }, { timeout: 3000 });
          await sleep(900);
          await autoScroll(page, 3);
          await add();
        } catch (_) {}
      }
    }

    // Cách 2: tab / nút / mục danh sách mang tên tỉnh/thành -> bấm lần lượt
    for (const label of uiLabels) {
      const clicked = await page.evaluate(({ label, foldSrc }) => {
        const fold = new Function('return ' + foldSrc)();
        const els = [...document.querySelectorAll('button,li,div,span,p,label,a')].filter((e) => {
          const t = (e.innerText || '').trim();
          return t && t.length < 40 && fold(t) === label;
        });
        const leaf = els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
        const el = leaf.find((e) => !(e.tagName === 'A' && e.getAttribute('href') && !e.getAttribute('href').startsWith('#')));
        if (!el) return false;
        el.click();
        return true;
      }, { label, foldSrc }).catch(() => false);
      if (clicked) { await sleep(800); await add(); }
    }
    log(`  -> tổng link rạp: ${links.size}`);
  }
  await page.close();
  return { links: [...links], logoUrl };
}

async function scrapeCinemas(context, globalJson) {
  const { links, logoUrl } = await discoverCinemaLinks(context);
  const cinemas = new Map();
  const page = await context.newPage();
  captureJson(page, 'cinemas');

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
          tables: [...document.querySelectorAll('table')].map((t) => [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.trim()))),
        };
      });
      const stops = ['Điện thoại', 'Hotline', 'Số điện thoại', 'Giờ mở cửa', 'Giá vé', 'Lịch chiếu', 'Phim'];
      let address = sliceSection(info.text, 'Địa chỉ', stops).slice(0, 2).join(', ') || null;
      if (!address) address = info.text.split('\n').find((l) => /(phường|xã|đặc khu|quận|huyện|thành phố|tỉnh)/i.test(l) && l.includes(',')) || null;

      let lat = null, lng = null, m = info.html.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
      if (m) { lng = +m[1]; lat = +m[2]; }
      else if ((m = info.html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)) || (m = info.html.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/))) { lat = +m[1]; lng = +m[2]; }

      const externalId = cinemaIdFromUrl(url);
      cinemas.set(externalId, makeCinemaRow({
        externalId, name: info.name, address,
        phone: info.tel || (info.text.match(/(0\d[\d. ]{8,12}\d)/) || [])[1] || null,
        latitude: lat, longitude: lng, url, priceTables: info.tables.length ? info.tables : null,
      }));
      log('  rạp:', info.name, '->', cinemas.get(externalId).provinceName || '(chưa rõ tỉnh)');
    } catch (e) {
      log('  ! lỗi rạp', url, e.message);
    }
    await politeWait();
  }
  await page.close();

  // Bổ sung / làm đầy bằng JSON API (nhiều khi có đủ rạp cả nước kèm địa chỉ + toạ độ)
  const byName = new Map([...cinemas.values()].map((c) => [norm(c.name), c]));
  for (const j of cinemasFromJson(globalJson)) {
    const hit = byName.get(norm(j.name));
    if (hit) {
      const merged = makeCinemaRow({ ...hit, address: hit.address || j.address, phone: hit.phone || j.phone,
        latitude: hit.latitude ?? j.latitude, longitude: hit.longitude ?? j.longitude });
      Object.assign(hit, merged);
    } else {
      const row = makeCinemaRow({ ...j, externalId: j.externalId || `name:${slugify(j.name)}`, discoveredFrom: 'json' });
      cinemas.set(row.externalId, row);
      byName.set(norm(row.name), row);
    }
  }
  return { cinemas: [...cinemas.values()], logoUrl };
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

/** "89.000đ" | 89000 | "89K" -> 89000 (VND) */
function parseVnd(v) {
  if (typeof v === 'number') return v >= 1000 ? Math.round(v) : null;
  const s = String(v || '');
  let m = s.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,7})/);
  if (m) return +m[1].replace(/[.,]/g, '');
  m = s.match(/\b(\d{2,3})\s?k\b/i);
  return m ? +m[1] * 1000 : null;
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
  const slug = item.url.split('/').filter(Boolean).pop();
  const movieObj = findMovieObject(blobs, slug); // object JSON đúng của phim này (tránh lấy nhầm phim khác)
  const headIdx = text.toLowerCase().indexOf('nội dung phim');
  const headText = headIdx > 0 ? text.slice(0, headIdx) : text.slice(0, 2500); // phần đầu trang: poster, điểm, thời lượng, độ tuổi...
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

  const durationMin = findDuration(headText, movieObj);

  const release =
    findReleaseDate(movieObj ? [movieObj] : []) ||
    parseDate(extractField(text, ['Khởi chiếu', 'Ngày khởi chiếu', 'Ngày chiếu', 'Release'])) ||
    parseDate((synopsis || '').match(/khởi chiếu[^\d]{0,20}(\d{1,2}[.\/-]\d{1,2}[.\/-]20\d{2})/i)?.[1]) ||
    findReleaseDate(blobs) ||
    null;

  // Trailer: iframe/link -> JSON của phim -> bấm nút Trailer (modal) -> quét HTML
  let trailerUrl = toYoutubeUrl(dom.trailer) || findTrailerInObject(movieObj);
  if (!trailerUrl) trailerUrl = await clickTrailer(page);
  if (!trailerUrl) trailerUrl = toYoutubeUrl(await page.content());

  const country = extractField(text, ['Quốc gia', 'Xuất xứ']);
  const siteLang = extractField(text, ['Ngôn ngữ']) || pickString(movieObj, /^(language|lang|ngonngu)/i);
  const inferredLang = siteLang ? null : inferLanguageFromCountry(country);

  // Tiêu đề dạng "English Title/ Tên Việt" -> tách originalTitle
  let title = dom.title || item.title;
  let originalTitle = null;
  if (title && title.includes('/')) {
    const [a, ...b] = title.split('/');
    originalTitle = a.trim();
    title = b.join('/').trim() || title;
  }

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
    ageRating: findAgeRating(extractField(text, ['Phân loại', 'Giới hạn độ tuổi']), headText, movieObj),
    status,
    posterUrl,
    backdropUrl,
    trailerUrl,
    language: siteLang || inferredLang || null, // ngôn ngữ gốc của phim
    languageSource: siteLang ? 'site' : inferredLang ? 'inferred-from-country' : null,
    audioVersions: [], // các bản chiếu có trên lịch (Phụ Đề / Lồng Tiếng...) - điền sau khi cào lịch chiếu
    country,
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

  movie.audioVersions = [...new Set(showtimes.map((s) => s.language).filter(Boolean))];

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

function buildOutput(scraped, cinemas, logoUrl, promotions, vouchers = []) {
  const keep = scraped.filter(({ movie: m }) =>
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

  // Rạp chỉ thấy trong lịch chiếu -> bản ghi tối thiểu; suy ra tỉnh/thành từ tên rạp
  const known = new Set(cinemas.map((c) => c.externalId));
  const cinemaAll = [...cinemas];
  for (const st of showtimes) {
    if (!known.has(st.cinemaExternalId)) {
      known.add(st.cinemaExternalId);
      cinemaAll.push(makeCinemaRow({ externalId: st.cinemaExternalId, name: st.cinemaName, discoveredFrom: 'showtime' }));
    }
  }

  // Tỉnh/thành: đủ 34 đơn vị; Phường/Xã: lấy từ địa chỉ rạp
  const provCount = {};
  const wardMap = new Map();
  for (const c of cinemaAll) {
    if (c.provinceCode) provCount[c.provinceCode] = (provCount[c.provinceCode] || 0) + 1;
    if (c.provinceCode && c.wardName) wardMap.set(`${c.provinceCode}|${c.wardName}`, { provinceCode: c.provinceCode, name: c.wardName, type: c.wardType });
  }
  const provinces = PROVINCES.map(([code, name, type]) => ({ code, name, type, cinemaCount: provCount[code] || 0 }));

  return {
    meta: { source: BASE, crawledAt: new Date().toISOString(), targetYear: TARGET_YEAR, note: 'Tham chiếu bằng khoá tự nhiên (slug, externalId, code); Core cấp UUID khi upsert.' },
    cinemaChain: { code: CHAIN_CODE, name: 'Galaxy Cinema', logoUrl, websiteUrl: BASE, isActive: true },
    provinces,
    wards: [...wardMap.values()],
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
    movieMetadata: keep.map((k) => k.metadata),
  };
}

function mergeOutputs(prev, next) {
  if (!prev) return next;
  const out = { ...next };
  out.cinemaChain = { ...prev.cinemaChain, ...nonNull(next.cinemaChain) };
  out.provinces = next.provinces; // luôn đủ 34 tỉnh/thành, cinemaCount tính lại theo danh sách rạp mới nhất
  out.wards = mergeBy(prev.wards, next.wards, (x) => `${x.provinceCode}|${x.name}`);
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
  fs.writeFileSync(path.join(OUT_DIR, 'galaxycine_provinces.csv'), toCSV(out.provinces));
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
  let cinemas = [], logoUrl = null, promotions = [], vouchers = [];

  // Bắt JSON API liên quan rạp (địa chỉ, toạ độ) / khuyến mãi trên toàn bộ các trang đã mở
  const globalJson = [];
  context.on('response', async (res) => {
    try {
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      if (!/galaxycine/i.test(res.url())) return;
      const body = await res.json();
      const str = JSON.stringify(body);
      if (str.length < 3_000_000 && /(galaxy|address|địa chỉ|khuyến mãi|promotion|voucher|ưu đãi)/i.test(str) && globalJson.length < 400) {
        globalJson.push({ url: res.url(), body });
      }
    } catch (_) {}
  });

  const save = () => finalizeAndSave(mergeOutputs(prev, buildOutput(scraped, cinemas, logoUrl, promotions, vouchers)));
  process.on('SIGINT', () => { log('Ctrl+C -> lưu dữ liệu đã cào...'); try { save(); } catch (_) {} process.exit(0); });

  try {
    // --- Rạp toàn quốc: quét từng tỉnh/thành, tách phường/xã ---
    ({ cinemas, logoUrl } = await scrapeCinemas(context, globalJson));
    const cinemaIndex = new Map(cinemas.map((c) => [norm(c.name).replace(/galaxy( cinema)?/g, '').trim(), c]));

    // --- Khuyến mãi ---
    const promo = await scrapePromotions(context, globalJson);
    promotions = promo.promotions.filter((p) =>
      [p.startsAt, p.endsAt].some((d) => d && +d.slice(0, 4) === TARGET_YEAR) || p.mediaYearHint === TARGET_YEAR || (PROMO_ALL && !p.startsAt && !p.endsAt)
    );
    const keepLinks = new Set(promotions.map((p) => p.linkUrl));
    vouchers = promo.vouchers.filter((v) => keepLinks.has(v.promotionLink));

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
    log(`Rạp: ${out.cinemas.length} | Tỉnh/thành có rạp: ${out.provinces.filter((x) => x.cinemaCount).length}/${out.provinces.length} | Phường/xã: ${out.wards.length}`);
    log(`Thể loại: ${out.genres.length} | Người: ${out.persons.length} | Khuyến mãi: ${out.promotions.length} | Voucher: ${out.vouchers.length}`);
    log('File: galaxycine_2026.json + CSV (provinces, cinemas, movies, showtimes, promotions, vouchers)');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseRange, parseVnd, promotionsFromJson, cinemasFromJson, makeCinemaRow, findDuration, findAgeRating, parseDuration, toYoutubeUrl, inferLanguageFromCountry, fold, PROVINCES, extractVoucherFromText, mergeOutputs, buildOutput, finalizeAndSave, parseDate, parseAddress, parseShowtimeLines, mapScreenFormat, extractLanguage, mapAgeRating, slugify, sliceSection, vnToUtcIso, inferYear };