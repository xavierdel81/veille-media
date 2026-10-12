// collector.mjs — Collecte les flux RSS avec fallback proxy
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_AGENT = "Mozilla/5.0 (compatible; VeilleMedia/1.0; +github-actions)";
const TIMEOUT_MS = 15000;

// Proxies publics pour les sites qui bloquent les IP de datacenters
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];

// ============================================================
// NETTOYAGE HTML
// ============================================================
function cleanHtml(input) {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
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
// FETCH AVEC RETRY + FALLBACK PROXY
// ============================================================
async function tryFetch(url, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    if (text.length < 200) return { ok: false, error: "Réponse trop courte" };
    if (!text.includes("<rss") && !text.includes("<feed") && !text.includes("<channel")) {
      return { ok: false, error: "Pas du XML RSS" };
    }
    return { ok: true, text };
  } catch (err) {
    const msg = err.name === "AbortError" ? `Timeout ${timeoutMs}ms` : `fetch failed: ${err.message}`;
    return { ok: false, error: msg };
  }
}

async function fetchFeed(source) {
  const start = Date.now();

  // 1️⃣ Tentative directe
  const direct = await tryFetch(source.url);
  if (direct.ok) {
    const items = parseFeed(direct.text, source);
    items.forEach(a => { a.themes = detectTheme(a.title, a.description); });
    return { source, status: "ok", items, ms: Date.now() - start, via: "direct" };
  }

  // 2️⃣ Si échec, on tente les proxies en cascade
  for (const proxyFn of CORS_PROXIES) {
    const proxyUrl = proxyFn(source.url);
    const proxied = await tryFetch(proxyUrl, 20000);
    if (proxied.ok) {
      const items = parseFeed(proxied.text, source);
      items.forEach(a => { a.themes = detectTheme(a.title, a.description); });
      return { source, status: "ok", items, ms: Date.now() - start, via: "proxy" };
    }
  }

  // 3️⃣ Tout a échoué
  return { source, status: "error", error: direct.error, ms: Date.now() - start, items: [] };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("🚀 Démarrage de la collecte…\n");

  const sources = JSON.parse(await readFile(resolve(__dirname, "sources.json"), "utf8"));
  console.log(`📋 ${sources.length} sources à tester\n`);

  const results = await Promise.allSettled(sources.map(fetchFeed));
  const all = [];
  const feedStatus = {};
  const okList = [];
  const koList = [];

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { source, status, items, ms, error, via } = r.value;
    feedStatus[source.id] = { status, items: items.length, ms, error, nom: source.nom, via };
    if (status === "ok" && items.length > 0) {
      all.push(...items);
      const tag = via === "proxy" ? " ⚠️" : "";
      okList.push(`${source.nom}${tag} (${items.length})`);
      console.log(`✅ ${source.nom.padEnd(30)} ${String(items.length).padStart(2)} art. (${ms}ms)${tag}`);
    } else {
      koList.push(`${source.nom} → ${error || "vide"}`);
      console.log(`❌ ${source.nom.padEnd(30)} ${error || "vide"} (${ms}ms)`);
    }
  }

  // Déduplication
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

  const okDirect = Object.values(feedStatus).filter(s => s.status === "ok" && s.via === "direct").length;
  const okProxy = Object.values(feedStatus).filter(s => s.status === "ok" && s.via === "proxy").length;

  const output = {
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    okSources: okList.length,
    koSources: koList.length,
    okDirect,
    okProxy,
    totalArticles: unique.length,
    articles: unique,
    feedStatus,
  };

  await writeFile(resolve(__dirname, "articles.json"), JSON.stringify(output, null, 2), "utf8");

  console.log("\n" + "=".repeat(70));
  console.log(`\n📊 BILAN`);
  console.log(`   Sources OK (direct) : ${okDirect}`);
  console.log(`   Sources OK (proxy)  : ${okProxy}`);
  console.log(`   Sources en échec    : ${koList.length}`);
  console.log(`   Articles uniques    : ${unique.length}`);
  if (koList.length > 0) {
    console.log(`\n❌ SOURCES EN ÉCHEC :`);
    koList.forEach(s => console.log(`   • ${s}`));
  }
  console.log(`\n💾 articles.json écrit\n`);
}

main().catch(err => {
  console.error("❌ Erreur fatale :", err);
  process.exit(1);
});
