// Pubblicatore StarLoupe: pubblica su Instagram i reel in coda quando arriva la loro ora.
// Gira dentro GitHub Actions ogni 15 minuti (.github/workflows/publish.yml), senza dipendenze.
//
// Uso: node scripts/publish.mjs [publish | dry-run | check]
//   publish  pubblica i post di queue/ con publish_at nel passato e li sposta in published/
//   dry-run  mostra cosa pubblicherebbe, senza chiamare Instagram
//   check    verifica che i token funzionino e mostra a quale profilo appartengono
//
// Variabili d'ambiente:
//   IG_TOKEN_IT, IG_TOKEN_EN   token Instagram (API with Instagram Login), uno per profilo
//   PAGES_BASE                 URL di GitHub Pages da cui Instagram scarica video e copertine
//   IG_API_VERSION             versione dell'API (default v23.0)
import fs from "node:fs/promises";
import path from "node:path";

const API = `https://graph.instagram.com/${process.env.IG_API_VERSION || "v23.0"}`;
const PAGES_BASE = (process.env.PAGES_BASE || "").replace(/\/$/, "");
const ACCOUNTS = ["it", "en"];
const MAX_ATTEMPTS = 3;
const QUEUE = "queue";
const DONE = "published";

const mode = process.argv[2] || "publish";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenFor = (account) => process.env[`IG_TOKEN_${account.toUpperCase()}`];

/** Errore temporaneo: il post resta in coda senza contare un tentativo (es. Pages non ancora aggiornato). */
class RetryLater extends Error {}

async function ig(method, endpoint, token, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  const all = { ...params, access_token: token };
  const init = { method };
  if (method === "GET") {
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, String(v));
  } else {
    init.body = new URLSearchParams(Object.entries(all).map(([k, v]) => [k, String(v)]));
  }
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    // mai stampare l'URL: contiene il token
    throw new Error(`${method} ${endpoint.split("?")[0]}: ${json.error?.message ?? `HTTP ${res.status}`}`);
  }
  return json;
}

const whoAmI = (token) => ig("GET", "me", token, { fields: "user_id,username" });

async function publishReel(post, token) {
  const me = await whoAmI(token);
  const igId = me.user_id ?? me.id;

  const videoUrl = `${PAGES_BASE}/${post.video}`;
  const head = await fetch(videoUrl, { method: "HEAD" });
  if (!head.ok) throw new RetryLater(`video non ancora online su Pages (HTTP ${head.status})`);

  const params = { media_type: "REELS", video_url: videoUrl, caption: post.caption ?? "", share_to_feed: "true" };
  if (post.cover) params.cover_url = `${PAGES_BASE}/${post.cover}`;
  else if (post.cover_ms != null) params.thumb_offset = post.cover_ms;

  // 1) contenitore: Instagram scarica e converte il video in modo asincrono
  const container = await ig("POST", `${igId}/media`, token, params);

  // 2) attesa della conversione (fino a 10 minuti)
  for (let i = 0; ; i++) {
    await sleep(15_000);
    const s = await ig("GET", container.id, token, { fields: "status_code,status" });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new Error(`conversione fallita (${s.status_code}): ${s.status ?? "nessun dettaglio"}`);
    }
    if (i >= 40) throw new Error("conversione troppo lunga (oltre 10 minuti)");
  }

  // 3) pubblicazione
  const published = await ig("POST", `${igId}/media_publish`, token, { creation_id: container.id });
  let permalink = null;
  try {
    permalink = (await ig("GET", published.id, token, { fields: "permalink" })).permalink;
  } catch {
    // il post è comunque online: il permalink è solo un comodo in più
  }
  return { media_id: published.id, permalink, username: me.username };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");

async function runCheck() {
  let ok = true;
  for (const account of ACCOUNTS) {
    const token = tokenFor(account);
    if (!token) {
      console.log(`${account}: nessun token configurato`);
      continue;
    }
    try {
      const me = await whoAmI(token);
      console.log(`${account}: token valido per @${me.username}`);
    } catch (e) {
      ok = false;
      console.log(`::error::${account}: token non valido (${e.message})`);
    }
  }
  if (!ok) process.exitCode = 1;
}

async function runQueue(dryRun) {
  if (!PAGES_BASE && !dryRun) throw new Error("PAGES_BASE non impostato");
  await fs.mkdir(DONE, { recursive: true });
  const files = (await fs.readdir(QUEUE)).filter((f) => f.endsWith(".json")).sort();
  const now = Date.now();
  let failed = false;
  let due = 0;

  for (const name of files) {
    const file = path.join(QUEUE, name);
    const post = await readJson(file);
    if (Date.parse(post.publish_at) > now) continue;
    if ((post.attempts ?? 0) >= MAX_ATTEMPTS) {
      console.log(`${name}: fermo dopo ${MAX_ATTEMPTS} tentativi (${post.last_error})`);
      failed = true;
      continue;
    }
    due++;
    if (dryRun) {
      console.log(`[dry-run] pubblicherei ${name} su ${post.account} (previsto ${post.publish_at})`);
      continue;
    }
    const token = tokenFor(post.account);
    if (!token) {
      console.log(`::error::${name}: manca il secret IG_TOKEN_${post.account.toUpperCase()}`);
      failed = true;
      continue;
    }

    try {
      console.log(`${name}: pubblico su ${post.account}...`);
      const result = await publishReel(post, token);
      const done = { ...post, status: "published", published_at: new Date().toISOString(), ...result };
      delete done.last_error;
      await writeJson(path.join(DONE, name), done);
      await fs.unlink(file);
      console.log(`${name}: pubblicato su @${result.username} ${result.permalink ?? ""}`);
    } catch (e) {
      if (e instanceof RetryLater) {
        console.log(`${name}: rimando al prossimo giro (${e.message})`);
        continue;
      }
      failed = true;
      post.attempts = (post.attempts ?? 0) + 1;
      post.last_error = e.message;
      await writeJson(file, post);
      console.log(`::error::${name}: tentativo ${post.attempts}/${MAX_ATTEMPTS} fallito: ${e.message}`);
    }
  }
  if (due === 0) console.log("Nessun post in scadenza.");
  if (failed) process.exitCode = 1;
}

if (mode === "check") await runCheck();
else if (mode === "dry-run") await runQueue(true);
else if (mode === "publish") await runQueue(false);
else {
  console.error(`Modalità sconosciuta: ${mode}`);
  process.exitCode = 2;
}
