// collector.mjs — Collecte les flux RSS côté serveur et écrit articles.json
// Tourne via GitHub Actions, pas dans le navigateur.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = "Mozilla/5.0 (compatible; VeilleMedia/1.0; +github-actions)";

// ============================================================
// PARSING RSS (regex simple, sans dépendance)
// ============================================================
function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " "); }
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/g, " ");
}
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
    const title = extractTag(block, "title");
    const link = isAtom ? extractAtomLink(block) : (extractTag(block, "link") || extractTag(block, "guid"));
    if (!title || !link) continue;
    const desc = extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated") || extractTag(block, "dc:date");
    const parsed = pubDate ? Date.parse(pubDate) : NaN;
    result.push({
      title: decodeHtml(stripTags(title)).trim().slice(0, 220),
      link: link.trim(),
      description: decodeHtml(stripTags(desc)).replace(/\s+/g, " ").trim().slice(0, 240),
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
  "luttes-sociales": ["grève", "manifestation", "syndicat", "mobilisation", "protestation", "social", "travailleurs", "salaires", "précarité", "chômage", "logement", "pauvreté", "inégalités", "austérité"],
  "corruption": ["corruption", "détournement", "fraude", "conflit d'intérêts", "pot-de-vin", "trafic d'influence", "malversation", "opacité", "clientélisme", "népotisme"],
  "transparence": ["transparence", "lanceur d'alerte", "accès aux documents", "publicité", "redevabilité", "open data", "cada", "secret d'état"],
  "democratie": ["démocratie", "élection", "parlement", "citoyen", "débat public", "libertés", "droits", "constitution", "vote", "pluralisme", "état de droit"],
  "auto-defense": ["zététique", "esprit critique", "sophisme", "manipulation", "fact-check", "fake news", "désinformation", "propagande", "rumeur", "novlangue"],
  "international": ["international", "monde", "guerre", "conflit", "diplomatie", "géopolitique", "étranger", "union européenne"],
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
// COLLECTE
// ============================================================
async function fetchFeed(source) {
  const start = Date.now();
  try {
    const res = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { source, status: "error", code: res.status, ms: Date.now() - start, items: [] };
    }
    const xml = await res.text();
    const items = parseFeed(xml, source);
    items.forEach(a => { a.themes = detectTheme(a.title, a.description); });
    return { source, status: "ok", items, ms: Date.now() - start };
  } catch (err) {
    return { source, status: "error", error: err.message, ms: Date.now() - start, items: [] };
  }
}

async function main() {
  console.log("🚀 Démarrage de la collecte…\n");

  const sourcesPath = resolve(__dirname, "sources.json");
  const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
  console.log(`📋 ${sources.length} sources à tester\n`);

  const results = await Promise.allSettled(sources.map(fetchFeed));
  const all = [];
  const feedStatus = {};

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { source, status, items, ms, code, error } = r.value;
    feedStatus[source.id] = { status, items: items.length, ms, code, error, nom: source.nom };
    if (status === "ok") {
      all.push(...items);
      console.log(`✅ ${source.nom.padEnd(28)} ${items.length} art. (${ms}ms)`);
    } else {
      console.log(`❌ ${source.nom.padEnd(28)} ${error || "HTTP " + code} (${ms}ms)`);
    }
  }

  // Déduplication
  const seen = new Set();
  const unique = all.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });
  unique.sort((a, b) => b.pubDate - a.pubDate);

  const okCount = Object.values(feedStatus).filter(s => s.status === "ok").length;
  const koCount = Object.values(feedStatus).filter(s => s.status === "error").length;

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

  console.log("\n" + "=".repeat(60));
  console.log(`\n📊 BILAN`);
  console.log(`   Sources OK      : ${okCount}`);
  console.log(`   Sources en échec: ${koCount}`);
  console.log(`   Articles uniques: ${unique.length}`);
  console.log(`\n💾 articles.json écrit avec succès\n`);
}

main().catch(err => {
  console.error("❌ Erreur fatale :", err);
  process.exit(1);
});