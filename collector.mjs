// collector.mjs — Collecte les flux RSS avec scoring thématique strict
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_AGENT = "Mozilla/5.0 (compatible; VeilleMedia/1.0; +github-actions)";
const TIMEOUT_MS = 15000;
const MAX_AGE_DAYS = 14;

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

// ============================================================
// NETTOYAGE DES URLs GOOGLE NEWS
// ============================================================
function cleanGoogleNewsUrl(url) {
  if (!url) return url;
  try {
    const match = url.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (!match) return url;

    const encoded = match[1];
    let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";

    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      const urlMatch = decoded.match(/https?:\/\/[^\s\x00-\x1f"']+/);
      if (urlMatch && urlMatch[0] && !urlMatch[0].includes("news.google.com")) {
        return urlMatch[0].replace(/[\x00-\x1f].*$/, "").replace(/["'<>].*$/, "").trim();
      }
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
  return url;
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
    const cleanLink = cleanGoogleNewsUrl(link.trim());

    result.push({
      title,
      link: cleanLink,
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
// DÉTECTION DE THÈME PAR SCORE (version stricte)
// ============================================================
const THEMES_SCORING = {
  "luttes-sociales": {
    weight: 1,
    kws: ["grève","greve","manifestation","syndicat","mobilisation","protestation","travailleurs","salaires","précarité","precarite","chômage","chomage","logement","pauvreté","pauvrete","inégalités","inegalites","austérité","austerite","retraite","licenciement","plan social","piquet","cortège","cortege","militant","collectif","solidarité","solidarite","revendication","débrayage","debrayage","précarisation","precarisation","exploitation","conditions de travail","accident du travail"]
  },
  "corruption": {
    weight: 1.5,
    kws: ["corruption","détournement","detournement","fraude","conflit d'intérêts","conflit d’intérêts","pot-de-vin","trafic d'influence","trafic d’influence","malversation","clientélisme","clientelisme","népotisme","nepotisme","favoritisme","commission occulte","dessous de table","enrichissement illicite","abus de biens","abus de confiance","prise illégale","prise illegale","faux et usage","corrompu","corrompue","pots-de-vin","pantouflage","notes de frais","déclaration de patrimoine","declaration de patrimoine"]
  },
  "transparence": {
    weight: 2,
    kws: [
      "cada","lanceur d'alerte","lanceur d’alerte","lanceurs d'alerte","lanceurs d’alerte","whistleblower","open data","données ouvertes","donnees ouvertes","freedom of information","accès aux documents","acces aux documents","accès à l'information","acces a l'information","liberté d'information","liberte d'information","publicité de l'administration","publicite de l'administration","commission d'accès","commission d’accès","transparencia",
      "transparence","secret d'état","secret d’état","secret des affaires","secret défense","secret defense","refus de communication","refus de transmettre","opacité administrative","opacite administrative","manque de transparence","défaut de transparence","defaut de transparence","demande de documents","demande d'accès","demande d’acces","droit de savoir","redevabilité","redevabilite","reddition des comptes","déclaration d'intérêts","declaration d'interets","registre des lobbyistes","agenda public","budget participatif","gouvernement ouvert","open government"
    ]
  },
  "democratie": {
    weight: 1,
    kws: ["démocratie","democratie","élection","election","parlement","citoyen","débat public","debat public","libertés","libertes","droits","constitution","vote","pluralisme","état de droit","etat de droit","référendum","referendum","suffrage","assemblée","assemblee","scrutin","député","depute","sénateur","senateur","gouvernement","participation citoyenne","démocratie locale","democratie locale","démocratie participative","democratie participative"]
  },
  "auto-defense": {
    weight: 1.3,
    kws: ["zététique","zetetique","esprit critique","sophisme","manipulation","fact-check","fact check","fake news","désinformation","desinformation","propagande","rumeur","novlangue","vérification","verification","décodage","decodage","démystification","demystification","complotisme","théorie du complot","theorie du complot","pensée critique","pensee critique","rhétorique","rhetorique","argumentation","biais cognitif"]
  },
  "international": {
    weight: 0.7,
    kws: ["international","monde","guerre","conflit","diplomatie","géopolitique","geopolitique","étranger","etranger","union européenne","union europeenne","onu","otan","gaza","ukraine","israël","israel","palestine","moyen-orient","afrique","asie","amérique","amerique"]
  },
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Termes TRÈS spécifiques qui suffisent à eux seuls à qualifier un thème
const HIGH_SIGNAL_TERMS = {
  "transparence": ["cada","lanceur d'alerte","lanceur d’alerte","lanceurs d'alerte","lanceurs d’alerte","whistleblower","open data","données ouvertes","donnees ouvertes","freedom of information","accès aux documents","acces aux documents","publicité de l'administration","publicite de l'administration","commission d'accès","commission d’accès","transparencia"],
  "corruption": ["corruption","détournement","detournement","pot-de-vin","pots-de-vin","trafic d'influence","trafic d’influence","malversation","népotisme","nepotisme","prise illégale","prise illegale","abus de biens","abus de confiance","pantouflage"],
  "auto-defense": ["zététique","zetetique","sophisme","fact-check","fake news","complotisme","théorie du complot","theorie du complot","désinformation","desinformation"]
};

function detectTheme(title, desc, url = "") {
  const urlText = url ? url.split("/").slice(-3).join(" ").replace(/-/g, " ") : "";
  const text = (title + " " + desc + " " + urlText).toLowerCase();
  const scores = {};

  for (const [theme, { weight, kws }] of Object.entries(THEMES_SCORING)) {
    let score = 0;
    let matchedKws = 0;
    const highSignal = HIGH_SIGNAL_TERMS[theme] || [];

    for (const kw of kws) {
      const regex = new RegExp("\\b" + escapeRegex(kw) + "\\b", "gi");
      const matches = text.match(regex);
      if (matches) {
        score += matches.length * weight;
        matchedKws++;
      }
    }

    if (score === 0) continue;

    const hasHighSignal = highSignal.some(kw => {
      const regex = new RegExp("\\b" + escapeRegex(kw) + "\\b", "i");
      return regex.test(text);
    });

    // Règle stricte pour les thèmes sensibles :
    // besoin d'un signal fort OU de 2 mots-clés distincts
    const strictThemes = ["corruption", "transparence", "auto-defense"];
    if (strictThemes.includes(theme)) {
      if (!hasHighSignal && matchedKws < 2) {
        continue;
      }
    }

    scores[theme] = score;
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
// FETCH
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
  items.forEach(a => { a.themes = detectTheme(a.title, a.description, a.link); });
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
      console.log(`✅ ${source.nom.padEnd(35)} ${String(items.length).padStart(2)} art. (${ms}ms)`);
    } else {
      koList.push(`${source.nom} → ${error || "vide"}`);
      console.log(`❌ ${source.nom.padEnd(35)} ${error || "vide"} (${ms}ms)`);
    }
  }

  // ============================================================
  // FUSION AVEC L'ANCIEN articles.json (fenêtre 14 jours)
  // ============================================================
  const ARTICLES_PATH = resolve(__dirname, "articles.json");
  let previousArticles = [];
  try {
    const previous = JSON.parse(await readFile(ARTICLES_PATH, "utf8"));
    if (previous.articles && Array.isArray(previous.articles)) {
      previousArticles = previous.articles;
      console.log(`\n📚 ${previousArticles.length} articles précédents à fusionner`);
    }
  } catch (e) { /* première collecte */ }

  const seenUrl = new Set();
  const seenTitle = new Set();
  const now = Date.now();
  const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 3600 * 1000;

  const merged = [...all, ...previousArticles].filter(a => {
    if (!a.pubDate || now - a.pubDate > MAX_AGE_MS) return false;
    if (seenUrl.has(a.link)) return false;
    seenUrl.add(a.link);
    const titleKey = a.title.toLowerCase().slice(0, 60);
    if (seenTitle.has(titleKey)) return false;
    seenTitle.add(titleKey);
    return true;
  });

  merged.sort((a, b) => b.pubDate - a.pubDate);

  // Recalcul COMPLET des thèmes pour tous les articles (au cas où la détection a changé)
  merged.forEach(a => {
    a.themes = detectTheme(a.title, a.description || "", a.link || "");
  });

  const themeCounts = {};
  merged.forEach(a => (a.themes || []).forEach(t => { themeCounts[t] = (themeCounts[t] || 0) + 1; }));

  const output = {
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    okSources: okList.length,
    koSources: koList.length,
    totalArticles: merged.length,
    themeCounts,
    articles: merged,
    feedStatus,
  };

  await writeFile(ARTICLES_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log("\n" + "=".repeat(70));
  console.log(`\n📊 BILAN`);
  console.log(`   Sources OK         : ${okList.length}`);
  console.log(`   Sources en échec   : ${koList.length}`);
  console.log(`   Nouveaux articles  : ${all.length}`);
  console.log(`   Archives fusionnées: ${previousArticles.length}`);
  console.log(`   TOTAL après fusion : ${merged.length}`);
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
