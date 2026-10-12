// collector.mjs — Collecte les flux RSS avec scoring thématique
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_AGENT = "Mozilla/5.0 (compatible; VeilleMedia/1.0; +github-actions)";
const TIMEOUT_MS = 15000;

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
// DÉTECTION DE THÈME PAR SCORE
// ============================================================
const THEMES_SCORING = {
  "luttes-sociales": {
    weight: 1,
    kws: ["grève","greve","manifestation","syndicat","mobilisation","protestation","travailleurs","salaires","précarité","precarite","chômage","chomage","logement","pauvreté","pauvrete","inégalités","inegalites","austérité","austerite","retraite","licenciement","plan social","piquet","cortège","cortege","militant","collectif","solidarité","solidarite","revendication","débrayage","debrayage"]
  },
  "corruption": {
    weight: 1.5,
    kws: ["corruption","détournement","detournement","fraude","conflit d'intérêts","conflit d’intérêts","pot-de-vin","trafic d'influence","trafic d’influence","malversation","opacité","opacite","clientélisme","clientelisme","népotisme","nepotisme","favoritisme","commission occulte","dessous de table","enrichissement","abus de biens","abus de confiance","prise illégale","prise illegale","faux et usage","corrompu","corrompue","pots-de-vin"]
  },
  "transparence": {
    weight: 1.3,
    kws: ["transparence","lanceur d'alerte","lanceur d’alerte","accès aux documents","acces aux documents","redevabilité","redevabilite","open data","cada","secret d'état","secret d’état","enquête publique","enquete publique","whistleblower","liberté d'information","liberte d'information","accès à l'information","acces a l'information"]
  },
  "democratie": {
    weight: 1,
    kws: ["démocratie","democratie","élection","election","parlement","citoyen","débat public","debat public","libertés","libertes","droits","constitution","vote","pluralisme","état de droit","etat de droit","référendum","referendum","suffrage","assemblée","assemblee","scrutin","député","depute","sénateur","senateur","gouvernement"]
  },
  "auto-defense": {
    weight: 1.3,
    kws: ["zététique","zetetique","esprit critique","sophisme","manipulation","fact-check","fact check","fake news","désinformation","desinformation","propagande","rumeur","novlangue","vérification","verification","décodage","decodage","démystification","demystification","complotisme","théorie du complot","theorie du complot"]
  },
  "international": {
    weight: 0.7,
    kws: ["international","monde","guerre","conflit","diplomatie","géopolitique","geopolitique","étranger","etranger","union européenne","union europeenne","onu","otan","gaza","ukraine","israël","israel","palestine","moyen-orient","afrique","asie","amérique","amerique"]
  },
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectTheme(title, desc) {
  const text = (title + " " + desc).toLowerCase();
  const scores = {};

  for (const [theme, { weight, kws }] of Object.entries(THEMES_SCORING)) {
    let score = 0;
    for (const kw of kws) {
      const regex = new RegExp("\\b" + escapeRegex(kw) + "\\b", "gi");
      const matches = text.match(regex);
      if (matches) score += matches.length * weight;
    }
    if (score > 0) scores[theme] = score;
  }

  const values = Object.values(scores);
  if (!values.length) return [];
  const maxScore = Math.max(...values);
  if (maxScore === 0) return [];

  const threshold = maxScore * 0.3;
  return Object.entries(scores)
    .filter(([, score]) => score >= threshold)
    .sort(([, a], [, b]) => b - a)
    .map(([theme]) => theme);
}

// ============================================================
// FETCH AVEC RETRY
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
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
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
  const result = await tryFetch(source.url);
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

  // Tri par date
  unique.sort((a, b) => b.pubDate - a.pubDate);

  // Comptage des thèmes pour le log
  const themeCounts = {};
  unique.forEach(a => (a.themes || []).forEach(t => { themeCounts[t] = (themeCounts[t] || 0) + 1; }));

  const output = {
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    okSources: okList.length,
    koSources: koList.length,
    totalArticles: unique.length,
    themeCounts,
    articles: unique,
    feedStatus,
  };

  await writeFile(resolve(__dirname, "articles.json"), JSON.stringify(output, null, 2), "utf8");

  console.log("\n" + "=".repeat(70));
  console.log(`\n📊 BILAN`);
  console.log(`   Sources OK      : ${okList.length}`);
  console.log(`   Sources en échec: ${koList.length}`);
  console.log(`   Articles uniques: ${unique.length}`);
  console.log(`\n📈 RÉPARTITION PAR THÈME :`);
  Object.entries(themeCounts)
    .sort(([, a], [, b]) => b - a)
    .forEach(([theme, count]) => console.log(`   ${theme.padEnd(20)} ${count} articles`));
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
