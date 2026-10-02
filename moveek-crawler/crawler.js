const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MOVIE_URLS = [
  "https://moveek.com/phim/vung-dat-quy-du-2026/",
  "https://moveek.com/phim/diem-mu/",
  "https://moveek.com/phim/tu-ho-dai-nao/"
];

const SHOWTIME_URL = "https://moveek.com/lich-chieu/";

const OUTPUT_DIR = path.join(__dirname, "output");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

function cleanText(value) {
  if (!value) return null;

  return value
    .replace(/\s+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
}

function sha1(value) {
  return crypto
    .createHash("sha1")
    .update(value)
    .digest("hex");
}

function parseDuration(text) {
  if (!text) return null;

  const match = text.match(/(\d+)\s*phút/i);

  return match ? Number(match[1]) : null;
}

function parseDate(text) {
  if (!text) return null;

  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (!match) return null;

  const [, day, month, year] = match;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function createExternalId(url) {
  return url
    .replace("https://moveek.com/phim/", "")
    .replace("/", "");
}

async function crawlMovie(page, url) {
  console.log(`\n🎬 Crawling movie: ${url}`);

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  await new Promise(resolve => setTimeout(resolve, 1500));

  const raw = await page.evaluate(() => {
    const bodyText = document.body.innerText;

    const getMeta = (property) => {
      const el =
        document.querySelector(`meta[property="${property}"]`) ||
        document.querySelector(`meta[name="${property}"]`);

      return el ? el.content : null;
    };

    const images = [...document.querySelectorAll("img")]
      .map(img => ({
        src: img.src,
        alt: img.alt
      }))
      .filter(x => x.src);

    const links = [...document.querySelectorAll("a")]
      .map(a => ({
        text: a.innerText.trim(),
        href: a.href
      }))
      .filter(x => x.href);

    return {
      title: document.querySelector("h1")?.innerText || null,

      description:
        getMeta("description") ||
        getMeta("og:description") ||
        null,

      posterUrl:
        getMeta("og:image") ||
        images[0]?.src ||
        null,

      images,

      links,

      bodyText
    };
  });

  return {
    externalId: createExternalId(url),
    source: "Moveek",
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    contentHash: sha1(JSON.stringify(raw)),
    raw
  };
}

async function crawlShowtimes(page) {
  console.log(`\n🍿 Crawling showtimes: ${SHOWTIME_URL}`);

  await page.goto(SHOWTIME_URL, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  const cinemas = await page.evaluate(() => {

    const result = [];

    /*
     * Moveek renders the schedule grouped by cinema.
     * We first collect visible text blocks and links.
     */

    const headings = [...document.querySelectorAll("h1,h2,h3,h4")];

    headings.forEach(heading => {

      const text = heading.innerText.trim();

      if (!text) return;

      const parent = heading.parentElement;

      if (!parent) return;

      result.push({
        heading: text,
        text: parent.innerText
      });
    });

    return result;
  });

  return {
    source: "Moveek",
    sourceUrl: SHOWTIME_URL,
    fetchedAt: new Date().toISOString(),
    raw: cinemas
  };
}

function normalizeMovie(rawMovie) {

  const text = rawMovie.raw.bodyText || "";

  const title = cleanText(rawMovie.raw.title);

  /*
   * Moveek movie pages expose:
   * title
   * original title
   * genres
   * release date
   * duration
   * age rating
   * cast
   * director
   */

  const lines = text
    .split("\n")
    .map(cleanText)
    .filter(Boolean);

  let originalTitle = null;
  let genres = [];
  let releaseDate = null;
  let durationMin = null;
  let ageRating = null;
  let director = null;
  let cast = [];

  const titleIndex = lines.findIndex(
    x => x === title
  );

  if (titleIndex >= 0 && lines[titleIndex + 1]) {

    const secondLine = lines[titleIndex + 1];

    /*
     * Example:
     * Resident Evil 2026 - Horror, Science Fiction
     */

    const parts = secondLine.split(" - ");

    if (parts.length >= 2) {
      originalTitle = cleanText(parts[0]);

      genres = parts[1]
        .split(",")
        .map(cleanText)
        .filter(Boolean);
    }
  }

  const releaseMatch = text.match(
    /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/
  );

  if (releaseMatch) {
    releaseDate = parseDate(releaseMatch[1]);
  }

  durationMin = parseDuration(text);

  const ratingMatch = text.match(
    /\b(T18|T16|T13|K|P)\b/
  );

  if (ratingMatch) {
    ageRating = ratingMatch[1];
  }

  const directorIndex = lines.findIndex(
    x => x.toLowerCase() === "đạo diễn"
  );

  if (
    directorIndex >= 0 &&
    lines[directorIndex + 1]
  ) {
    director = lines[directorIndex + 1];
  }

  const castIndex = lines.findIndex(
    x => x.toLowerCase() === "diễn viên"
  );

  if (castIndex >= 0) {

    const castText = lines[castIndex + 1];

    if (castText) {
      cast = castText
        .split(/\s{2,}/)
        .map(cleanText)
        .filter(Boolean);
    }
  }

  return {
    movieId: `MOV-${rawMovie.externalId}`,

    externalId: rawMovie.externalId,

    slug: rawMovie.externalId,

    title,

    originalTitle,

    synopsis: cleanText(rawMovie.raw.description),

    durationMin,

    releaseDate,

    ageRating,

    status: "NOW_SHOWING",

    posterUrl: rawMovie.raw.posterUrl,

    backdropUrl: null,

    trailerUrl:
      rawMovie.raw.links.find(link =>
        /trailer/i.test(link.text)
      )?.href || null,

    language: null,

    country: null,

    ratingAvg: null,

    ratingCount: null,

    genres,

    credits: {
      director,
      cast
    },

    source: {
      chain: "MOVEek",
      externalId: rawMovie.externalId,
      url: rawMovie.sourceUrl
    },

    crawledAt: rawMovie.fetchedAt
  };
}

async function main() {

  console.log("====================================");
  console.log(" CineHub - Moveek Crawler");
  console.log("====================================");

  const browser = await puppeteer.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 900
  });

  const rawMovies = [];

  for (const url of MOVIE_URLS) {

    try {

      const movie = await crawlMovie(page, url);

      rawMovies.push(movie);

      console.log(
        `✅ ${movie.raw.title || movie.externalId}`
      );

    } catch (error) {

      console.error(
        `❌ Failed: ${url}`
      );

      console.error(error.message);
    }
  }

  let showtimes = null;

  try {

    showtimes = await crawlShowtimes(page);

    console.log("✅ Showtime page crawled");

  } catch (error) {

    console.error(
      "❌ Showtime crawl failed:",
      error.message
    );
  }

  const normalizedMovies = rawMovies.map(
    normalizeMovie
  );

  const normalizedData = {

    meta: {
      project: "CineHub",

      source: "Moveek",

      sourceType: "CRAWLED",

      crawler: "Puppeteer",

      crawledAt: new Date().toISOString(),

      totalMovies:
        normalizedMovies.length
    },

    movies: normalizedMovies,

    showtimes: showtimes
      ? []
      : []
  };

  fs.writeFileSync(

    path.join(
      OUTPUT_DIR,
      "crawl-raw.json"
    ),

    JSON.stringify(
      {
        source: "Moveek",
        crawledAt:
          new Date().toISOString(),
        movies: rawMovies,
        showtimes
      },
      null,
      2
    )
  );

  fs.writeFileSync(

    path.join(
      OUTPUT_DIR,
      "movie-metadata.json"
    ),

    JSON.stringify(
      normalizedMovies,
      null,
      2
    )
  );

  fs.writeFileSync(

    path.join(
      OUTPUT_DIR,
      "cinehub-normalized.json"
    ),

    JSON.stringify(
      normalizedData,
      null,
      2
    )
  );

  await browser.close();

  console.log("\n====================================");
  console.log(" CRAWL COMPLETED");
  console.log("====================================");

  console.log(
    `Movies: ${normalizedMovies.length}`
  );

  console.log(
    "Output: ./output/"
  );
}

main().catch(error => {

  console.error(error);

  process.exit(1);

});