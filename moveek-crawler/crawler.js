const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ============================================================
// CONFIG
// ============================================================

const BASE_URL = "https://moveek.com";
const TARGET_YEAR = 2026;

const CONFIG = {
  maxPages: 3000,
  delayMs: 700,
  retries: 3,
  navigationTimeout: 45000,

  allowedHost: "moveek.com",

  saveRawHtml: true,
  maxRawHtmlLength: 2_000_000,
};

const OUTPUT_DIR = path.join(__dirname, "output");
const RAW_DIR = path.join(OUTPUT_DIR, "raw");

// ============================================================
// OUTPUT SETUP
// ============================================================

if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, {
    recursive: true,
    force: true,
  });
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

// ============================================================
// UTILS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function absoluteUrl(url) {
  try {
    return new URL(url, BASE_URL).href;
  } catch {
    return null;
  }
}

function sha1(value) {
  return crypto
    .createHash("sha1")
    .update(String(value))
    .digest("hex");
}

function writeJSON(filename, data) {
  const filePath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  console.log(
    `💾 ${filename}: ${
      Array.isArray(data) ? data.length : "object"
    } records`
  );
}

function normalizeDate(value) {
  if (!value) return null;

  const text = cleanText(value);

  let match = text.match(
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/
  );

  if (match) {
    return `${match[1]}-${String(match[2]).padStart(
      2,
      "0"
    )}-${String(match[3]).padStart(2, "0")}`;
  }

  match = text.match(
    /\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/
  );

  if (match) {
    return `${match[3]}-${String(match[2]).padStart(
      2,
      "0"
    )}-${String(match[1]).padStart(2, "0")}`;
  }

  match = text.match(
    /\b(\d{1,2})\s*(?:tháng)\s*(\d{1,2})\s*(?:năm)?\s*(20\d{2})\b/i
  );

  if (match) {
    return `${match[3]}-${String(match[2]).padStart(
      2,
      "0"
    )}-${String(match[1]).padStart(2, "0")}`;
  }

  return null;
}

function isTargetYear(value) {
  if (!value) return false;

  return String(value).includes(String(TARGET_YEAR));
}

function normalizeDuration(value) {
  if (!value) return null;

  const text = cleanText(value);

  const match = text.match(
    /(\d+)\s*(?:phút|minutes?|mins?)/i
  );

  return match ? Number(match[1]) : null;
}

function detectAgeRating(text) {
  const value = cleanText(text);

  const match = value.match(/\bT(?:13|16|18)\b/i);

  if (match) return match[0].toUpperCase();

  if (/\bP\b/.test(value)) return "P";
  if (/\bK\b/.test(value)) return "K";

  return null;
}

function detectFormat(text) {
  const value = cleanText(text);

  if (/\bIMAX\b/i.test(value)) return "IMAX";
  if (/\b4DX\b/i.test(value)) return "4DX";
  if (/\b3D\b/i.test(value)) return "3D";
  if (/\b2D\b/i.test(value)) return "2D";

  return null;
}

function detectLanguage(text) {
  const value = cleanText(text);

  if (/phụ\s*đề/i.test(value)) {
    return "Phụ Đề Việt";
  }

  if (/lồng\s*tiếng/i.test(value)) {
    return "Lồng Tiếng";
  }

  if (/tiếng\s*việt/i.test(value)) {
    return "Tiếng Việt";
  }

  return null;
}

// ============================================================
// PRICE PARSER
// ============================================================

function parsePrice(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const text = String(value)
    .replace(/\./g, "")
    .replace(/,/g, "")
    .trim();

  const match = text.match(/\b(\d{4,7})\b/);

  if (!match) return null;

  const price = Number(match[1]);

  if (price < 1000 || price > 2_000_000) {
    return null;
  }

  return price;
}

// ============================================================
// URL CLASSIFICATION
// ============================================================

function classifyUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.toLowerCase();

    if (pathname === "/" || pathname === "") {
      return "home";
    }

    if (pathname.startsWith("/tag/")) {
      return "tag";
    }

    if (pathname.startsWith("/phim/")) {
      return "movie";
    }

    if (pathname.startsWith("/rap/")) {
      return "cinema";
    }

    if (pathname.startsWith("/lich-chieu")) {
      return "showtime";
    }

    if (pathname.startsWith("/dang-chieu")) {
      return "movie-list";
    }

    if (pathname.startsWith("/chieu-som")) {
      return "movie-list";
    }

    if (pathname.startsWith("/tin-tuc/")) {
      return "article";
    }

    if (pathname === "/tin-tuc") {
      return "news-index";
    }

    if (pathname.startsWith("/mua-ve")) {
      return "booking";
    }

    if (pathname.startsWith("/tim-kiem")) {
      return "search";
    }

    if (pathname.startsWith("/search")) {
      return "search";
    }

    if (
      pathname.startsWith("/dang-nhap") ||
      pathname.startsWith("/dang-ky") ||
      pathname.startsWith("/tai-khoan")
    ) {
      return "account";
    }

    return "other";
  } catch {
    return "other";
  }
}

// ============================================================
// URL FILTER
// ============================================================

function shouldSkipUrl(url) {
  try {
    const u = new URL(url);

    if (u.hostname !== CONFIG.allowedHost) {
      return true;
    }

    const pathname = u.pathname.toLowerCase();

    const blocked = [
      "/tag/",
      "/tim-kiem",
      "/search",
      "/dang-nhap",
      "/dang-ky",
      "/tai-khoan",
    ];

    return blocked.some((item) =>
      pathname.startsWith(item)
    );
  } catch {
    return true;
  }
}

// ============================================================
// COMMON PAGE DATA
// ============================================================

async function extractCommonPageData(page) {
  return await page.evaluate(() => {
    const getMeta = (name) => {
      const el =
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[property="${name}"]`);

      return el
        ? el.getAttribute("content")
        : null;
    };

    const links = Array.from(
      document.querySelectorAll("a")
    )
      .map((a) => ({
        text: a.innerText?.trim() || "",
        href: a.href || "",
      }))
      .filter((x) => x.href);

    const images = Array.from(document.images)
      .map(
        (img) =>
          img.src ||
          img.getAttribute("data-src")
      )
      .filter(Boolean);

    return {
      title: document.title || "",

      metaDescription:
        getMeta("description") || "",

      ogTitle:
        getMeta("og:title") || "",

      ogDescription:
        getMeta("og:description") || "",

      ogImage:
        getMeta("og:image") || "",

      canonical:
        document.querySelector(
          'link[rel="canonical"]'
        )?.href || "",

      h1:
        document.querySelector("h1")
          ?.innerText?.trim() || "",

      bodyText:
        document.body?.innerText || "",

      links,
      images,

      html:
        document.documentElement
          ?.outerHTML || "",
    };
  });
}

// ============================================================
// MOVIE
// ============================================================

async function crawlMovie(page, url) {
  const common =
    await extractCommonPageData(page);

  const body = common.bodyText;

  const title =
    cleanText(common.h1) ||
    cleanText(common.ogTitle) ||
    cleanText(common.title);

  const originalTitle =
    body.match(
      /(?:Tên gốc|Original Title)\s*:?\s*([^\n]+)/i
    )?.[1] || null;

  const synopsis =
    body.match(
      /(?:Nội dung|Nội dung phim|Synopsis)\s*:?\s*([\s\S]{0,1500})/i
    )?.[1] ||
    common.ogDescription ||
    "";

  const releaseCandidates = [
    body.match(
      /(?:Khởi chiếu|Ngày khởi chiếu|Release Date)\s*:?\s*([^\n]+)/i
    )?.[1],

    body.match(
      /\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b/
    )?.[0],
  ];

  let releaseDate = null;

  for (const candidate of releaseCandidates) {
    const date = normalizeDate(candidate);

    if (date) {
      releaseDate = date;
      break;
    }
  }

  const durationMin =
    body.match(
      /(\d{2,3})\s*(?:phút|minutes?|mins?)/i
    )?.[1]
      ? Number(
          body.match(
            /(\d{2,3})\s*(?:phút|minutes?|mins?)/i
          )[1]
        )
      : normalizeDuration(body);

  const ageRating =
    detectAgeRating(body);

  const status =
    /đang chiếu/i.test(body)
      ? "NOW_SHOWING"
      : /sắp chiếu|chưa chiếu/i.test(body)
      ? "COMING_SOON"
      : null;

  const posterUrl =
    common.ogImage ||
    common.images.find((img) =>
      /poster|phim|movie/i.test(img)
    ) ||
    common.images[0] ||
    null;

  const backdropUrl =
    common.images.find((img) =>
      /backdrop|cover|banner/i.test(img)
    ) || null;

  const trailerUrl =
    common.links.find((item) =>
      /youtube|youtu\.be/i.test(
        item.href
      )
    )?.href || null;

  const director =
    body.match(
      /(?:Đạo diễn|Director)\s*:?\s*([^\n]+)/i
    )?.[1]
      ? unique(
          body
            .match(
              /(?:Đạo diễn|Director)\s*:?\s*([^\n]+)/i
            )[1]
            .split(/,|\/|;/)
            .map(cleanText)
        )
      : [];

  const producer =
    body.match(
      /(?:Nhà sản xuất|Producer)\s*:?\s*([^\n]+)/i
    )?.[1]
      ? unique(
          body
            .match(
              /(?:Nhà sản xuất|Producer)\s*:?\s*([^\n]+)/i
            )[1]
            .split(/,|\/|;/)
            .map(cleanText)
        )
      : [];

  const cast =
    body.match(
      /(?:Diễn viên|Cast|Actors?)\s*:?\s*([^\n]+)/i
    )?.[1]
      ? unique(
          body
            .match(
              /(?:Diễn viên|Cast|Actors?)\s*:?\s*([^\n]+)/i
            )[1]
            .split(/,|\/|;/)
            .map(cleanText)
        )
      : [];

  const ratingAvg =
    body.match(
      /(?:điểm|rating|đánh giá)\s*:?\s*(\d+(?:[.,]\d+)?)/i
    )?.[1]
      ? Number(
          body
            .match(
              /(?:điểm|rating|đánh giá)\s*:?\s*(\d+(?:[.,]\d+)?)/i
            )[1]
            .replace(",", ".")
        )
      : null;

  const ratingCount =
    body.match(
      /(\d[\d.,]*)\s*(?:đánh giá|reviews?|ratings?)/i
    )?.[1]
      ? Number(
          body
            .match(
              /(\d[\d.,]*)\s*(?:đánh giá|reviews?|ratings?)/i
            )[1]
            .replace(/[.,]/g, "")
        )
      : null;

  const movie = {
    externalId: sha1(url),

    slug: (() => {
      try {
        return new URL(url)
          .pathname
          .replace(/^\/phim\//, "")
          .replace(/\/$/, "");
      } catch {
        return null;
      }
    })(),

    title,
    originalTitle,
    synopsis: cleanText(synopsis),

    durationMin,
    releaseDate,
    ageRating,
    status,

    posterUrl,
    backdropUrl,
    trailerUrl,

    language:
      detectLanguage(body),

    country: null,

    ratingAvg,
    ratingCount,

    genres: [],
    director,
    producer,
    cast,

    sourceUrl: url,
  };

  if (!isTargetYear(movie.releaseDate)) {
    console.log(
      `⏭️ SKIP MOVIE NOT 2026: ${title}`
    );

    return null;
  }

  return movie;
}

// ============================================================
// CINEMA
// ============================================================

async function crawlCinema(page, url) {
  const common =
    await extractCommonPageData(page);

  const body = common.bodyText;

  const name =
    cleanText(common.h1) ||
    cleanText(common.ogTitle) ||
    cleanText(common.title);

  const address =
    body.match(
      /(?:Địa chỉ|Address)\s*:?\s*([^\n]+)/i
    )?.[1] || null;

  const phone =
    body.match(
      /(?:Hotline|Điện thoại|Phone)\s*:?\s*([^\n]+)/i
    )?.[1] || null;

  const knownChains = [
    "CGV",
    "Galaxy Cinema",
    "Lotte Cinema",
    "Beta Cinemas",
    "BHD Star",
    "Cinestar",
    "Mega GS",
    "DCINE",
  ];

  const chain =
    knownChains.find((x) =>
      new RegExp(x, "i").test(name)
    ) || null;

  return {
    externalId: sha1(url),

    name,
    chain,

    address: cleanText(address),
    phone: cleanText(phone),

    province: null,
    district: null,

    latitude: null,
    longitude: null,

    sourceUrl: url,
  };
}

// ============================================================
// SHOWTIMES + PRICE
// ============================================================

async function crawlShowtimes(page, url) {
  const data =
    await page.evaluate(() => {
      const bodyText =
        document.body?.innerText || "";

      const priceTexts =
        Array.from(
          document.querySelectorAll(
            [
              "[data-price]",
              "[data-ticket-price]",
              "[data-amount]",
              ".price",
              ".ticket-price",
              ".showtime-price",
              ".ticketPrice",
            ].join(",")
          )
        ).map((el) => ({
          text:
            el.innerText ||
            el.textContent ||
            "",

          price:
            el.getAttribute(
              "data-price"
            ) ||
            el.getAttribute(
              "data-ticket-price"
            ) ||
            el.getAttribute(
              "data-amount"
            ) ||
            null,

          movie:
            el.getAttribute(
              "data-movie"
            ) || null,

          cinema:
            el.getAttribute(
              "data-cinema"
            ) || null,

          showtime:
            el.getAttribute(
              "data-showtime"
            ) || null,

          seatType:
            el.getAttribute(
              "data-seat-type"
            ) || null,
        }));

      // Search JSON/script data for price-related
      // information without inventing values.
      const scripts =
        Array.from(
          document.querySelectorAll(
            "script"
          )
        ).map(
          (s) => s.textContent || ""
        );

      return {
        bodyText,
        priceTexts,
        scripts,
      };
    });

  const body = data.bodyText;

  const lines = body
    .split("\n")
    .map(cleanText)
    .filter(Boolean);

  const results = [];
  const prices = [];

  let currentDate = null;
  let currentCinema = null;
  let currentMovie = null;
  let currentFormat = null;
  let currentLanguage = null;

  // ----------------------------------------------------------
  // SHOWTIME PARSING
  // ----------------------------------------------------------

  for (const line of lines) {
    const date = normalizeDate(line);

    if (date) {
      currentDate = date;
      continue;
    }

    if (
      /CGV|Galaxy|Lotte|Beta|BHD|Cinestar|Mega GS|DCINE|Cinema|Cineplex/i.test(
        line
      )
    ) {
      currentCinema = line;
    }

    const format =
      detectFormat(line);

    if (format) {
      currentFormat = format;
    }

    const language =
      detectLanguage(line);

    if (language) {
      currentLanguage = language;
    }

    if (
      line.length > 2 &&
      line.length < 150 &&
      !/^\d{1,2}:\d{2}$/.test(line) &&
      !/^\d{1,2}h\d{2}$/i.test(line) &&
      !/^(2D|3D|4DX|IMAX)$/i.test(line) &&
      !/địa chỉ|hotline|thời lượng|khởi chiếu|đạo diễn|diễn viên|nội dung/i.test(
        line
      )
    ) {
      currentMovie =
        currentMovie || line;
    }

    const timeMatches =
      line.match(
        /\b\d{1,2}(?::|h)\d{2}\b/g
      );

    if (!timeMatches) continue;

    if (!currentDate) continue;

    if (!isTargetYear(currentDate)) {
      continue;
    }

    for (const time of timeMatches) {
      const normalizedTime =
        time
          .replace("h", ":")
          .replace("H", ":");

      const showtime = {
        externalId: sha1(
          `${url}|${currentDate}|${currentCinema}|${currentMovie}|${normalizedTime}`
        ),

        movie: currentMovie,
        cinema: currentCinema,

        date: currentDate,

        startTime:
          normalizedTime,

        endTime: null,

        format:
          currentFormat,

        language:
          currentLanguage,

        status:
          "AVAILABLE",

        source:
          "Moveek",

        sourceUrl:
          url,
      };

      results.push(showtime);
    }
  }

  // ----------------------------------------------------------
  // PRICE PARSING FROM DOM
  // ----------------------------------------------------------

  for (const item of data.priceTexts) {
    const candidates = [
      item.price,
      item.text,
    ];

    let price = null;

    for (const candidate of candidates) {
      price = parsePrice(candidate);

      if (price) break;
    }

    if (!price) continue;

    prices.push({
      externalId: sha1(
        `${url}|${item.movie}|${item.cinema}|${item.showtime}|${item.seatType}|${price}`
      ),

      movie:
        item.movie ||
        null,

      cinema:
        item.cinema ||
        null,

      showtime:
        item.showtime ||
        null,

      seatType:
        item.seatType ||
        null,

      price,

      currency:
        "VND",

      source:
        "Moveek",

      sourceUrl:
        url,
    });
  }

  // ----------------------------------------------------------
  // DEDUP SHOWTIMES
  // ----------------------------------------------------------

  const showtimeMap =
    new Map();

  for (const item of results) {
    const key = [
      item.movie,
      item.cinema,
      item.date,
      item.startTime,
      item.format,
      item.language,
    ].join("|");

    if (!showtimeMap.has(key)) {
      showtimeMap.set(
        key,
        item
      );
    }
  }

  // ----------------------------------------------------------
  // DEDUP PRICES
  // ----------------------------------------------------------

  const priceMap =
    new Map();

  for (const item of prices) {
    const key = [
      item.movie,
      item.cinema,
      item.showtime,
      item.seatType,
      item.price,
    ].join("|");

    if (!priceMap.has(key)) {
      priceMap.set(
        key,
        item
      );
    }
  }

  return {
    showtimes:
      [...showtimeMap.values()],

    prices:
      [...priceMap.values()],
  };
}

// ============================================================
// REVIEW CRAWLER
// ============================================================

async function crawlReviews(page, url) {
  const data =
    await page.evaluate(() => {
      const selectors = [
        ".review",
        ".reviews",
        ".review-item",
        ".review-content",
        ".comment",
        ".comment-item",
        ".comment-content",
        "[class*='review']",
        "[class*='comment']",
      ];

      const elements =
        Array.from(
          document.querySelectorAll(
            selectors.join(",")
          )
        );

      const reviews =
        elements.map((el) => {
          const text =
            el.innerText ||
            el.textContent ||
            "";

          const authorEl =
            el.querySelector(
              [
                ".author",
                ".username",
                ".user-name",
                "[class*='author']",
                "[class*='user']",
              ].join(",")
            );

          const ratingEl =
            el.querySelector(
              [
                "[data-rating]",
                ".rating",
                "[class*='rating']",
              ].join(",")
            );

          const dateEl =
            el.querySelector(
              [
                "time",
                ".date",
                ".created-at",
                "[class*='date']",
              ].join(",")
            );

          return {
            text: text.trim(),

            author:
              authorEl
                ?.innerText
                ?.trim() ||
              null,

            rating:
              ratingEl?.getAttribute(
                "data-rating"
              ) ||
              ratingEl
                ?.innerText
                ?.trim() ||
              null,

            date:
              dateEl
                ?.getAttribute(
                  "datetime"
                ) ||
              dateEl
                ?.innerText
                ?.trim() ||
              null,
          };
        });

      // Also inspect JSON-LD / script data.
      const scripts =
        Array.from(
          document.querySelectorAll(
            "script"
          )
        ).map(
          (s) => s.textContent || ""
        );

      return {
        reviews,
        scripts,
      };
    });

  const reviews = [];

  // ----------------------------------------------------------
  // DOM REVIEWS
  // ----------------------------------------------------------

  for (const item of data.reviews) {
    const text =
      cleanText(item.text);

    if (!text) continue;

    // Ignore containers that are clearly
    // navigation/layout rather than reviews.
    if (text.length < 3) continue;

    const date =
      normalizeDate(item.date);

    // If a review has a date and it is not 2026,
    // exclude it.
    if (
      item.date &&
      date &&
      !isTargetYear(date)
    ) {
      continue;
    }

    let rating = null;

    if (item.rating) {
      const match =
        String(
          item.rating
        ).match(
          /\d+(?:[.,]\d+)?/
        );

      if (match) {
        rating = Number(
          match[0].replace(
            ",",
            "."
          )
        );
      }
    }

    reviews.push({
      externalId: sha1(
        `${url}|${item.author}|${date}|${text}`
      ),

      movieUrl:
        url,

      author:
        cleanText(
          item.author
        ) || null,

      rating,

      content:
        text,

      createdAt:
        date,

      source:
        "Moveek",

      sourceUrl:
        url,
    });
  }

  // ----------------------------------------------------------
  // DEDUP
  // ----------------------------------------------------------

  const map =
    new Map();

  for (const review of reviews) {
    if (
      !map.has(
        review.externalId
      )
    ) {
      map.set(
        review.externalId,
        review
      );
    }
  }

  return [
    ...map.values(),
  ];
}

// ============================================================
// ARTICLE / NEWS
// ============================================================

async function crawlArticle(
  page,
  url
) {
  const common =
    await extractCommonPageData(
      page
    );

  const body =
    common.bodyText;

  const title =
    cleanText(common.h1) ||
    cleanText(common.ogTitle) ||
    cleanText(common.title);

  const publishedCandidates = [
    body.match(
      /(?:Ngày đăng|Đăng lúc|Published|Published at)\s*:?\s*([^\n]+)/i
    )?.[1],

    body.match(
      /\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b/
    )?.[0],
  ];

  let publishedAt = null;

  for (const candidate of publishedCandidates) {
    const date =
      normalizeDate(candidate);

    if (date) {
      publishedAt = date;
      break;
    }
  }

  if (
    !isTargetYear(
      publishedAt
    )
  ) {
    console.log(
      `⏭️ SKIP NEWS NOT 2026: ${title}`
    );

    return null;
  }

  const author =
    body.match(
      /(?:Tác giả|Author)\s*:?\s*([^\n]+)/i
    )?.[1] || null;

  return {
    externalId:
      sha1(url),

    title,

    category:
      null,

    author:
      cleanText(author),

    publishedAt,

    thumbnail:
      common.ogImage ||
      common.images[0] ||
      null,

    summary:
      common.metaDescription ||
      common.ogDescription,

    content:
      body,

    sourceUrl:
      url,
  };
}

// ============================================================
// RAW PAGE
// ============================================================

async function saveRawPage(
  page,
  url,
  type
) {
  const common =
    await extractCommonPageData(
      page
    );

  const contentHash =
    sha1(common.html);

  const record = {
    id:
      sha1(url),

    url,
    type,

    contentHash,

    crawledAt:
      new Date().toISOString(),

    title:
      common.title,

    h1:
      common.h1,

    html:
      CONFIG.saveRawHtml
        ? common.html.slice(
            0,
            CONFIG.maxRawHtmlLength
          )
        : null,
  };

  if (
    CONFIG.saveRawHtml
  ) {
    const htmlFile =
      `${contentHash}.html`;

    fs.writeFileSync(
      path.join(
        RAW_DIR,
        htmlFile
      ),
      common.html.slice(
        0,
        CONFIG.maxRawHtmlLength
      ),
      "utf8"
    );

    record.rawHtmlFile =
      `raw/${htmlFile}`;
  }

  return record;
}

// ============================================================
// SAFE GOTO
// ============================================================

async function safeGoto(
  page,
  url
) {
  for (
    let attempt = 1;
    attempt <= CONFIG.retries;
    attempt++
  ) {
    try {
      await page.goto(
        url,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            CONFIG.navigationTimeout,
        }
      );

      await sleep(
        CONFIG.delayMs
      );

      return true;
    } catch (error) {
      console.log(
        `⚠️ Navigation failed ${attempt}/${CONFIG.retries}: ${url}`
      );

      console.log(
        `   ${error.message}`
      );

      if (
        attempt <
        CONFIG.retries
      ) {
        await sleep(
          1500 * attempt
        );
      }
    }
  }

  return false;
}

// ============================================================
// DISCOVER LINKS
// ============================================================

async function discoverLinks(
  page
) {
  try {
    return await page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll(
            "a"
          )
        )
          .map(
            (a) => a.href
          )
          .filter(Boolean)
    );
  } catch (error) {
    console.log(
      `⚠️ Link discovery failed: ${error.message}`
    );

    return [];
  }
}

// ============================================================
// NORMALIZED DATA
// ============================================================

function buildNormalizedData(
  movies,
  cinemas,
  showtimes,
  prices,
  reviews
) {
  return {
    source:
      "Moveek",

    targetYear:
      TARGET_YEAR,

    crawledAt:
      new Date().toISOString(),

    movies,

    cinemas,

    showtimes,

    prices,

    reviews,
  };
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  const startedAt =
    new Date();

  console.log(
    "=============================================="
  );

  console.log(
    "🎬 CINEHUB MOVEek CRAWLER"
  );

  console.log(
    "=============================================="
  );

  console.log(
    `📅 Target year: ${TARGET_YEAR}`
  );

  console.log(
    `🌐 Base URL: ${BASE_URL}`
  );

  console.log(
    "=============================================="
  );

  const browser =
    await puppeteer.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

  const page =
    await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 900,
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/154.0.0.0 Safari/537.36"
  );

  await page.setRequestInterception(
    true
  );

  page.on(
    "request",
    (request) => {
      const resourceType =
        request.resourceType();

      if (
        [
          "font",
          "media",
        ].includes(
          resourceType
        )
      ) {
        request.abort();
      } else {
        request.continue();
      }
    }
  );

  page.on(
    "pageerror",
    (error) => {
      console.log(
        `⚠️ PAGE ERROR: ${error.message}`
      );
    }
  );

  page.on(
    "error",
    (error) => {
      console.log(
        `⚠️ PAGE CRASH: ${error.message}`
      );
    }
  );

  // ==========================================================
  // SEEDS
  // ==========================================================

  const seeds = [
    `${BASE_URL}/`,
    `${BASE_URL}/dang-chieu/`,
    `${BASE_URL}/chieu-som/`,
    `${BASE_URL}/lich-chieu/`,
    `${BASE_URL}/rap/`,
    `${BASE_URL}/tin-tuc/`,
    `${BASE_URL}/mua-ve/`,
  ];

  const queue = [
    ...seeds,
  ];

  const visited =
    new Set();

  const rawRecords = [];

  const moviesMap =
    new Map();

  const cinemasMap =
    new Map();

  const showtimesMap =
    new Map();

  const pricesMap =
    new Map();

  const newsMap =
    new Map();

  const reviewsMap =
    new Map();

  // ==========================================================
  // CRAWL LOOP
  // ==========================================================

  while (
    queue.length > 0 &&
    visited.size <
      CONFIG.maxPages
  ) {
    const url =
      queue.shift();

    if (!url) continue;

    if (
      visited.has(url)
    ) {
      continue;
    }

    visited.add(url);

    if (
      shouldSkipUrl(url)
    ) {
      console.log(
        `⏭️ SKIP: ${url}`
      );

      continue;
    }

    const type =
      classifyUrl(url);

    if (
      [
        "tag",
        "search",
        "account",
        "other",
      ].includes(type)
    ) {
      console.log(
        `⏭️ SKIP ${type.toUpperCase()}: ${url}`
      );

      continue;
    }

    console.log(
      `\n[${visited.size}/${CONFIG.maxPages}] ${type.toUpperCase()}`
    );

    console.log(url);

    // --------------------------------------------------------
    // NAVIGATION
    // --------------------------------------------------------

    const success =
      await safeGoto(
        page,
        url
      );

    if (!success) {
      console.log(
        `❌ FAILED NAVIGATION: ${url}`
      );

      continue;
    }

    // --------------------------------------------------------
    // RAW
    // --------------------------------------------------------

    try {
      const raw =
        await saveRawPage(
          page,
          url,
          type
        );

      rawRecords.push(
        raw
      );
    } catch (error) {
      console.log(
        `⚠️ RAW ERROR: ${url}`
      );

      console.log(
        `   ${error.message}`
      );
    }

    // --------------------------------------------------------
    // EXTRACT
    // --------------------------------------------------------

    try {
      if (
        type === "movie"
      ) {
        const movie =
          await crawlMovie(
            page,
            url
          );

        if (movie) {
          moviesMap.set(
            movie.externalId,
            movie
          );

          console.log(
            `🎬 MOVIE 2026: ${movie.title}`
          );

          // Crawl reviews from movie page
          try {
            const reviews =
              await crawlReviews(
                page,
                url
              );

            for (
              const review of reviews
            ) {
              reviewsMap.set(
                review.externalId,
                review
              );
            }

            console.log(
              `💬 REVIEWS: ${reviews.length}`
            );
          } catch (
            reviewError
          ) {
            console.log(
              `⚠️ REVIEW ERROR: ${reviewError.message}`
            );
          }
        }
      }

      else if (
        type === "cinema"
      ) {
        const cinema =
          await crawlCinema(
            page,
            url
          );

        if (cinema) {
          cinemasMap.set(
            cinema.externalId,
            cinema
          );

          console.log(
            `🏢 CINEMA: ${cinema.name}`
          );
        }

        // Cinema pages can also contain
        // showtimes and prices.
        try {
          const result =
            await crawlShowtimes(
              page,
              url
            );

          for (
            const showtime
            of result.showtimes
          ) {
            showtimesMap.set(
              showtime.externalId,
              showtime
            );
          }

          for (
            const price
            of result.prices
          ) {
            pricesMap.set(
              price.externalId,
              price
            );
          }

          console.log(
            `🕐 SHOWTIMES: ${result.showtimes.length}`
          );

          console.log(
            `💰 PRICES: ${result.prices.length}`
          );
        } catch (
          showtimeError
        ) {
          console.log(
            `⚠️ CINEMA SHOWTIME/PRICE ERROR: ${showtimeError.message}`
          );
        }
      }

      else if (
        type === "showtime"
      ) {
        const result =
          await crawlShowtimes(
            page,
            url
          );

        for (
          const showtime
          of result.showtimes
        ) {
          showtimesMap.set(
            showtime.externalId,
            showtime
          );
        }

        for (
          const price
          of result.prices
        ) {
          pricesMap.set(
            price.externalId,
            price
          );
        }

        console.log(
          `🕐 SHOWTIMES 2026: ${result.showtimes.length}`
        );

        console.log(
          `💰 PRICES: ${result.prices.length}`
        );
      }

      else if (
        type === "article"
      ) {
        const article =
          await crawlArticle(
            page,
            url
          );

        if (article) {
          newsMap.set(
            article.externalId,
            article
          );

          console.log(
            `📰 NEWS 2026: ${article.title}`
          );
        }
      }
    } catch (error) {
      // Detached Frame or another page-level error
      // will only skip this URL.
      console.log(
        `❌ ERROR: ${url}`
      );

      console.log(
        `   ${error.message}`
      );
    }

    // --------------------------------------------------------
    // DISCOVER
    // --------------------------------------------------------

    try {
      const links =
        await discoverLinks(
          page
        );

      for (
        const link of links
      ) {
        if (!link) continue;

        let normalized;

        try {
          const parsed =
            new URL(
              link,
              BASE_URL
            );

          parsed.hash = "";

          normalized =
            parsed.href;
        } catch {
          continue;
        }

        if (
          !normalized.startsWith(
            BASE_URL
          )
        ) {
          continue;
        }

        if (
          shouldSkipUrl(
            normalized
          )
        ) {
          continue;
        }

        if (
          !visited.has(
            normalized
          ) &&
          !queue.includes(
            normalized
          )
        ) {
          queue.push(
            normalized
          );
        }
      }
    } catch (error) {
      console.log(
        `⚠️ DISCOVERY ERROR: ${error.message}`
      );
    }
  }

  // ==========================================================
  // FINAL ARRAYS
  // ==========================================================

  let movies =
    [...moviesMap.values()];

  let cinemas =
    [...cinemasMap.values()];

  let showtimes =
    [...showtimesMap.values()];

  let prices =
    [...pricesMap.values()];

  let news =
    [...newsMap.values()];

  let reviews =
    [...reviewsMap.values()];

  // ==========================================================
  // FINAL 2026 FILTER
  // ==========================================================

  movies =
    movies.filter(
      (movie) =>
        isTargetYear(
          movie.releaseDate
        )
    );

  showtimes =
    showtimes.filter(
      (showtime) =>
        isTargetYear(
          showtime.date ||
            showtime.startTime
        )
    );

  news =
    news.filter(
      (article) =>
        isTargetYear(
          article.publishedAt
        )
    );

  reviews =
    reviews.filter(
      (review) => {
        if (
          !review.createdAt
        ) {
          // Keep undated reviews because
          // there is no evidence they belong
          // to another year.
          return true;
        }

        return isTargetYear(
          review.createdAt
        );
      }
    );

  prices =
    prices.filter(
      (price) => {
        if (
          price.showtime
        ) {
          return true;
        }

        return true;
      }
    );

  // ==========================================================
  // SORT
  // ==========================================================

  movies.sort(
    (a, b) =>
      String(
        a.releaseDate || ""
      ).localeCompare(
        String(
          b.releaseDate || ""
        )
      )
  );

  cinemas.sort(
    (a, b) =>
      String(
        a.name || ""
      ).localeCompare(
        String(
          b.name || ""
        )
      )
  );

  showtimes.sort(
    (a, b) =>
      String(
        `${a.date || ""} ${
          a.startTime || ""
        }`
      ).localeCompare(
        `${b.date || ""} ${
          b.startTime || ""
        }`
      )
  );

  news.sort(
    (a, b) =>
      String(
        a.publishedAt || ""
      ).localeCompare(
        String(
          b.publishedAt || ""
        )
      )
  );

  // ==========================================================
  // NORMALIZED
  // ==========================================================

  const normalized =
    buildNormalizedData(
      movies,
      cinemas,
      showtimes,
      prices,
      reviews
    );

  // ==========================================================
  // CRAWL RUN
  // ==========================================================

  const finishedAt =
    new Date();

  const crawlRun = {
    source:
      "Moveek",

    targetYear:
      TARGET_YEAR,

    startedAt:
      startedAt.toISOString(),

    finishedAt:
      finishedAt.toISOString(),

    durationMs:
      finishedAt.getTime() -
      startedAt.getTime(),

    maxPages:
      CONFIG.maxPages,

    pagesVisited:
      visited.size,

    queueRemaining:
      queue.length,

    counts: {
      movies:
        movies.length,

      cinemas:
        cinemas.length,

      showtimes:
        showtimes.length,

      prices:
        prices.length,

      news:
        news.length,

      reviews:
        reviews.length,

      rawPages:
        rawRecords.length,
    },
  };

  // ==========================================================
  // WRITE JSON
  // ==========================================================

  writeJSON(
    "crawl-runs.json",
    [crawlRun]
  );

  writeJSON(
    "crawl-raw.json",
    rawRecords
  );

  writeJSON(
    "movies.json",
    movies
  );

  writeJSON(
    "cinemas.json",
    cinemas
  );

  writeJSON(
    "showtimes.json",
    showtimes
  );

  writeJSON(
    "prices.json",
    prices
  );

  writeJSON(
    "news.json",
    news
  );

  writeJSON(
    "reviews.json",
    reviews
  );

  writeJSON(
    "cinehub-normalized.json",
    [normalized]
  );

  // ==========================================================
  // SUMMARY
  // ==========================================================

  console.log(
    "\n=============================================="
  );

  console.log(
    "✅ CRAWL FINISHED"
  );

  console.log(
    "=============================================="
  );

  console.log(
    `📅 TARGET YEAR : ${TARGET_YEAR}`
  );

  console.log(
    `🌐 PAGES       : ${visited.size}`
  );

  console.log(
    `🎬 MOVIES      : ${movies.length}`
  );

  console.log(
    `🏢 CINEMAS     : ${cinemas.length}`
  );

  console.log(
    `🕐 SHOWTIMES   : ${showtimes.length}`
  );

  console.log(
    `💰 PRICES      : ${prices.length}`
  );

  console.log(
    `📰 NEWS        : ${news.length}`
  );

  console.log(
    `💬 REVIEWS     : ${reviews.length}`
  );

  console.log(
    `📦 RAW         : ${rawRecords.length}`
  );

  console.log(
    "=============================================="
  );

  console.log(
    `📁 Output: ${OUTPUT_DIR}`
  );

  await browser.close();

})().catch(
  (error) => {
    console.error(
      "\n❌ FATAL CRAWLER ERROR:"
    );

    console.error(
      error
    );

    process.exit(1);
  }
);
