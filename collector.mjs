// collector.mjs — Collecte les flux RSS côté serveur
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// CONFIGURATION HTTP
// ============================================================
// User-Agent Chrome réaliste (contourne les 403 anti-bot)
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Headers qui imitent un vrai navigateur
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.9",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

const TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;

// ============================================================
// NETTOYAGE HTML ROBUSTE
// ============================================================
function cleanHtml(input) {
  if (!input) return "";
  let s = String(input);

  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ============================================================
// PARSING RSS
// ============================================================
function extractTag(block, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i");
  const cm = block.match(cdataRe);
  if (cm) return cm[1];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}
function extractAtomLink(block) {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return alt[1];
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return any ? any[1] : "";
}

function parseFeed(xml, source) {
  const isAtom = /<feed[\s>]/.test(xml);
  const itemRegex = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(itemRegex) || [];
  const result = [];

  for (const block of blocks.slice(0, 20)) {
    const rawTitle = extractTag(block, "title");
    const link = isAtom ? extractAtomLink(block) : (extractTag(block, "link") || extractTag(block, "guid"));
    const rawDesc = extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content");
    const rawDate = extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated") || extractTag(block, "dc:date");

    const title = cleanHtml(rawTitle).slice(0, 220);
    const description = cleanHtml(rawDesc).slice(0, 280);

    if (!title || title.length < 5) continue;
    if (!link || !/^https?:\/\//i.test(link.trim())) continue;
    if (title.toLowerCase() === source.nom.toLowerCase()) continue;

    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    result.push({
      title,
      link: link.trim(),
      description,
      pubDate: Number.isFinite(parsed) ? parsed : Date.now(),
      sourceId: source.id,
      source: source.nom,
      pays: source.pays,
      langue: source.langue,
      bord: source.bord,
    });
  }
  return result;
}

// ============================================================
// DÉTECTION DE THÈME
// ============================================================
const THEMES_KEYWORDS = {
  "luttes-sociales": ["grève","manifestation","syndicat","mobilisation","protestation","travailleurs","salaires","précarité","chômage","logement","pauvreté","inégalités","austérité","retraite"],
  "corruption": ["corruption","détournement","fraude","conflit d'intérêts","pot-de-vin","trafic d'influence","malversation","opacité","clientélisme","népotisme","favoritisme"],
  "transparence": ["transparence","lanceur d'alerte","accès aux documents","redevabilité","open data","cada","secret d'état","enquête publique"],
  "democratie": ["démocratie","élection","parlement","citoyen","débat public","libertés","droits","constitution","vote","pluralisme","état de droit","référendum"],
  "auto-defense": ["zététique","esprit critique","sophisme","manipulation","fact-check","fake news","désinformation","propagande","rumeur","novlangue","vérification"],
  "international": ["international","monde","guerre","conflit","diplomatie","géopolitique","étranger","union européenne","onu","otan"],
};
function detectTheme(title, desc) {
  const text = (title + " " + desc).toLowerCase();
  const found = [];
  for (const [theme, kws] of Object.entries(THEMES_KEYWORDS)) {
    if (kws.some(kw => text.includes(kw))) found.push(theme);
  }
  return found;
}

// ============================================================
// FETCH AVEC RETRY ET TIMEOUT LONG
// ============================================================
async function fetchWithRetry(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // 404 = flux mort, pas la peine de retry
      if (res.status === 404) {
        return { ok: false, status: res.status, error: `HTTP 404` };
      }
      // 403 = anti-bot, on retry avec un délai
      if (res.status === 403 && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
        return fetchWithRetry(url, attempt + 1);
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (!text || text.length < 200) {
      return { ok: false, status: 200, error: "Réponse trop courte" };
    }
    return { ok: true, text };
  } catch (err) {
    clearTimeout(timeout);

    // Timeout ou erreur réseau → retry
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1500));
      return fetchWithRetry(url, attempt + 1);
    }

    const msg = err.name === "AbortError"
      ? `Timeout ${TIMEOUT_MS}ms (×${attempt})`
      : `fetch failed: ${err.message}`;
    return { ok: false, error: msg };
  }
}

// ============================================================
// COLLECTE D'UNE SOURCE
// ============================================================
async function fetchFeed(source) {
  const start = Date.now();
  const result = await fetchWithRetry(source.url);
  const ms = Date.now() - start;

  if (!result.ok) {
    return { source, status: "error", error: result.error, ms, items: [] };
  }

  const items = parseFeed(result.text, source);
  items.forEach(a => { a.themes = detectTheme(a.title, a.description); });
  return { source, status: "ok", items, ms };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("🚀 Démarrage de la collecte…\n");

  const sources = JSON.parse(await readFile(resolve(__dirname, "sources.json"), "utf8"));
  console.log(`📋 ${sources.length} sources à tester\n`);
  console.log(`⚙️  Timeout : ${TIMEOUT_MS}ms · Retries : ${MAX_RETRIES}`);
  console.log(`🌐 User-Agent : Chrome 131\n`);

  const results = await Promise.allSettled(sources.map(fetchFeed));
  const all = [];
  const feedStatus = {};
  const okList = [];
  const koList = [];

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { source, status, items, ms, error } = r.value;
    feedStatus[source.id] = { status, items: items.length, ms, error, nom: source.nom };
    if (status === "ok" && items.length > 0) {
      all.push(...items);
      okList.push(`${source.nom} (${items.length})`);
      console.log(`✅ ${source.nom.padEnd(30)} ${String(items.length).padStart(2)} art. (${ms}ms)`);
    } else {
      koList.push(`${source.nom} → ${error || "vide"}`);
      console.log(`❌ ${source.nom.padEnd(30)} ${error || "vide"} (${ms}ms)`);
    }
  }

  // Déduplication par URL + par titre
  const seenUrl = new Set();
  const seenTitle = new Set();
  const unique = all.filter(a => {
    if (seenUrl.has(a.link)) return false;
    const titleKey = a.title.toLowerCase().slice(0, 60);
    if (seenTitle.has(titleKey)) return false;
    seenUrl.add(a.link);
    seenTitle.add(titleKey);
    return true;
  });
  unique.sort((a, b) => b.pubDate - a.pubDate);

  const okCount = okList.length;
  const koCount = koList.length;

  const output = {
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    okSources: okCount,
    koSources: koCount,
    totalArticles: unique.length,
    articles: unique,
    feedStatus,
  };

  await writeFile(resolve(__dirname, "articles.json"), JSON.stringify(output, null, 2), "utf8");

  console.log("\n" + "=".repeat(70));
  console.log(`\n📊 BILAN`);
  console.log(`   Sources OK      : ${okCount}`);
  console.log(`   Sources en échec: ${koCount}`);
  console.log(`   Articles uniques: ${unique.length}`);
  if (koCount > 0) {
    console.log(`\n❌ SOURCES EN ÉCHEC :`);
    koList.forEach(s => console.log(`   • ${s}`));
  }
  console.log(`\n💾 articles.json écrit\n`);
}

main().catch(err => {
  console.error("❌ Erreur fatale :", err);
  process.exit(1);
});
