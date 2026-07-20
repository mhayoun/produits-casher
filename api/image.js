/**
 * /api/image?q=<query>
 *
 * Serverless, database-backed product-image resolver.
 *
 *   1. Look up the query in Upstash Redis (key-value cache). Cache hit -> return immediately.
 *   2. Cache miss -> call an image search provider (first configured one wins; Openverse is a
 *      keyless default so this endpoint works with zero configuration).
 *   3. Re-host the found image permanently in Vercel Blob (object storage) instead of hot-linking
 *      the third-party URL, so it survives even if the source disappears / rate-limits us.
 *   4. Persist the final { url, source, title } row in Redis (permanent) and return it.
 *
 * All client devices therefore share one resolution per product string: the first visitor
 * "pays" for the search + upload, every subsequent visitor (and every other user of the
 * catalog) gets an instant cached hit — no client-side search quota is ever touched.
 *
 * ORDER IN WHICH IMAGES ARE LOOKED UP (first hit wins):
 *   1. Redis cache (Upstash)                     — always checked first, regardless of config
 *   2. Bing Image Search v7   (BING_IMAGE_SEARCH_KEY)   — if configured
 *   3. SerpApi / Google Images (SERPAPI_KEY)            — if configured
 *   4. Openverse (keyless, CC-licensed)                 — always available, last resort
 *
 * DEBUG LOGGING
 *   Verbose step-by-step logs ("[image] ...") are printed automatically whenever the function
 *   is NOT running in a Vercel Production deployment (i.e. `vercel dev`, Preview deployments).
 *   Force it either way with DEBUG_IMAGES=1 (always verbose) or DEBUG_IMAGES=0 (always quiet,
 *   errors only). Run `vercel dev` and watch that same terminal — every request/provider/cache
 *   step is printed live there (see README "Tester en local").
 *
 * Env vars (all optional — the endpoint degrades gracefully without them):
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   -> Upstash Redis (or KV_REST_API_URL/KV_REST_API_TOKEN
 *                                                            if you used the Vercel KV / Upstash integration)
 *   BLOB_READ_WRITE_TOKEN                                -> Vercel Blob (auto-set by the Blob integration)
 *   BING_IMAGE_SEARCH_KEY                                 -> Bing Image Search v7
 *   SERPAPI_KEY                                           -> SerpApi (Google Images engine)
 *   DEBUG_IMAGES                                          -> "1" force verbose logs, "0" force quiet
 *   (none of the above set)                               -> falls back to Openverse (keyless, CC-licensed)
 */

import { Redis } from "@upstash/redis";
import { put } from "@vercel/blob";

/* ---------------------------------------------------------------
   Debug logger — verbose locally / in Preview, quiet in Production,
   overridable with DEBUG_IMAGES=1|0. Every log line is prefixed so
   it's easy to grep in `vercel dev` output or the Vercel dashboard.
--------------------------------------------------------------- */
const DEBUG =
  process.env.DEBUG_IMAGES === "1"
    ? true
    : process.env.DEBUG_IMAGES === "0"
    ? false
    : process.env.VERCEL_ENV !== "production";

function dlog(...args) {
  if (DEBUG) console.log("[image]", ...args);
}
function dtime(label) {
  const start = Date.now();
  return () => (DEBUG ? console.log("[image]", label, `(${Date.now() - start}ms)`) : null);
}

/* ---------------------------------------------------------------
   Key-value store (Upstash Redis) — with a per-instance in-memory
   fallback so local dev / preview without env vars still works.
--------------------------------------------------------------- */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const REDIS_ENABLED = !!(REDIS_URL && REDIS_TOKEN);

const redis = REDIS_ENABLED ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;
const memoryCache = new Map(); // ephemeral fallback, scoped to a single serverless instance

const NAMESPACE = "prodimg:v1:";
const NEGATIVE_TTL_SECONDS = 60 * 60 * 6; // re-try "not found" queries after 6h, don't retry forever

function cacheKey(q) {
  return NAMESPACE + q.toLowerCase().trim().replace(/\s+/g, " ");
}

async function readCache(key) {
  const done = dtime(`cache READ (${REDIS_ENABLED ? "redis" : "memory"}) "${key}"`);
  if (redis) {
    try {
      const val = await redis.get(key);
      done();
      dlog(val ? "cache HIT (redis)" : "cache MISS (redis)");
      return val;
    } catch (e) {
      console.error("[image] redis GET failed, falling back to memory:", e.message);
    }
  }
  const val = memoryCache.get(key) || null;
  done();
  dlog(val ? "cache HIT (memory)" : "cache MISS (memory)");
  return val;
}

async function writeCache(key, value, ttlSeconds) {
  if (redis) {
    try {
      if (ttlSeconds) await redis.set(key, value, { ex: ttlSeconds });
      else await redis.set(key, value);
      dlog(`cache WRITE (redis, ${ttlSeconds ? `ttl=${ttlSeconds}s` : "permanent"})`, key);
      return;
    } catch (e) {
      console.error("[image] redis SET failed, falling back to memory:", e.message);
    }
  }
  memoryCache.set(key, value);
  dlog("cache WRITE (memory, ephemeral)", key);
}

/* ---------------------------------------------------------------
   Per-instance circuit breaker for providers that are *misconfigured*
   (e.g. a revoked key, etc). Distinct from "no results for this query" —
   this is "this provider cannot serve ANY query right now", so
   there's no point paying the network round-trip on every single
   request until someone fixes the underlying config. Trips for a
   few minutes, then re-checks (in case it gets fixed mid-instance).
--------------------------------------------------------------- */
const CIRCUIT_BREAKER_MS = 10 * 60 * 1000; // 10 minutes
const providerBrokenUntil = new Map(); // providerName -> timestamp

function isProviderTripped(name) {
  const until = providerBrokenUntil.get(name);
  return !!until && Date.now() < until;
}

function tripBreaker(name, reason) {
  providerBrokenUntil.set(name, Date.now() + CIRCUIT_BREAKER_MS);
  console.error(
    `[image] ${name} — CONFIG ERROR, disabling for ${CIRCUIT_BREAKER_MS / 60000}min: ${reason}`
  );
}

function looksLikeConfigError(status, bodyText) {
  if (status === 401 || status === 403) return true;
  return /api.*not.*enabl|does not have.*access|invalid.*api.*key|forbidden/i.test(bodyText || "");
}

/* ---------------------------------------------------------------
   Image search providers — tried in order, first hit wins.
   Each one logs the exact URL/site it queries (API keys redacted).
--------------------------------------------------------------- */
async function searchBing(query) {
  const key = process.env.BING_IMAGE_SEARCH_KEY;
  if (!key) {
    dlog("Bing — skipped (BING_IMAGE_SEARCH_KEY not set)");
    return null;
  }
  if (isProviderTripped("bing")) {
    dlog("Bing — skipped (circuit breaker tripped, see earlier CONFIG ERROR log)");
    return null;
  }
  const url = `https://api.bing.microsoft.com/v7.0/images/search?q=${encodeURIComponent(query)}&count=1&safeSearch=Moderate`;
  dlog("Bing — searching:", JSON.stringify(query));
  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": key } });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    dlog("Bing — HTTP", res.status, bodyText.slice(0, 200));
    if (looksLikeConfigError(res.status, bodyText)) {
      tripBreaker("bing", "check BING_IMAGE_SEARCH_KEY is valid and the resource is active in Azure");
    }
    return null;
  }
  const data = await res.json();
  const item = data.value && data.value[0];
  if (!item) {
    dlog("Bing — no results");
    return null;
  }
  dlog("Bing — found:", item.contentUrl);
  return { url: item.contentUrl, source: "bing", title: item.name };
}

async function searchSerpApi(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    dlog("SerpApi — skipped (SERPAPI_KEY not set)");
    return null;
  }
  if (isProviderTripped("serpapi")) {
    dlog("SerpApi — skipped (circuit breaker tripped, see earlier CONFIG ERROR log)");
    return null;
  }
  const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}&api_key=${key}`;
  dlog("SerpApi — searching:", JSON.stringify(query));
  const res = await fetch(url);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    dlog("SerpApi — HTTP", res.status, bodyText.slice(0, 200));
    if (looksLikeConfigError(res.status, bodyText)) {
      tripBreaker("serpapi", "check SERPAPI_KEY is valid and the account has remaining searches");
    }
    return null;
  }
  const data = await res.json();
  const item = data.images_results && data.images_results[0];
  if (!item) {
    dlog("SerpApi — no results");
    return null;
  }
  dlog("SerpApi — found:", item.original);
  return { url: item.original, source: "serpapi", title: item.title };
}

async function searchOpenverse(query) {
  // Keyless, CC-licensed image search — the zero-configuration default / last resort.
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=1&mature=false`;
  dlog("Openverse — searching:", JSON.stringify(query));
  const res = await fetch(url, { headers: { "User-Agent": "produits-casher/1.0 (image lookup)" } });
  if (!res.ok) {
    dlog("Openverse — HTTP", res.status);
    return null;
  }
  const data = await res.json();
  const item = data.results && data.results[0];
  if (!item) {
    dlog("Openverse — no results");
    return null;
  }
  dlog("Openverse — found:", item.url);
  return { url: item.url, source: "openverse", title: item.title, credit: item.creator };
}

const PROVIDERS = [searchBing, searchSerpApi, searchOpenverse];

function providerConfigSummary() {
  const status = (envConfigured, name) => {
    if (!envConfigured) return "not configured";
    return isProviderTripped(name) ? "TRIPPED (config error)" : "configured";
  };
  return [
    `bing=${status(process.env.BING_IMAGE_SEARCH_KEY, "bing")}`,
    `serpapi=${status(process.env.SERPAPI_KEY, "serpapi")}`,
    `openverse=always available`,
  ].join(" > ");
}

// Logged once per cold start so you immediately see the effective provider order.
dlog("provider order:", providerConfigSummary());
dlog("redis:", REDIS_ENABLED ? "enabled (Upstash)" : "disabled — using in-memory cache fallback");
if (DEBUG) {
  const fingerprint = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)} (len ${v.length})` : "(not set)");
  console.log("[image] cold-start key fingerprints (to catch stale/wrong env files):");
  console.log("[image]   BING_IMAGE_SEARCH_KEY:", fingerprint(process.env.BING_IMAGE_SEARCH_KEY));
  console.log("[image]   SERPAPI_KEY   :", fingerprint(process.env.SERPAPI_KEY));
}

async function resolveImage(query) {
  for (const provider of PROVIDERS) {
    const done = dtime(`${provider.name} call`);
    try {
      const result = await provider(query);
      done();
      if (result && result.url) return result;
    } catch (e) {
      done();
      console.error(`[image] provider ${provider.name} failed:`, e.message);
    }
  }
  return null;
}

/* ---------------------------------------------------------------
   Permanent re-hosting into the object store (Vercel Blob), so we
   never depend on a third-party CDN link staying alive.
--------------------------------------------------------------- */
const BLOB_ENABLED = !!process.env.BLOB_READ_WRITE_TOKEN;

async function persistToBlob(imageUrl, query) {
  if (!BLOB_ENABLED) {
    dlog("Blob — skipped (BLOB_READ_WRITE_TOKEN not set), keeping hot-linked URL:", imageUrl);
    return imageUrl;
  }
  const done = dtime("Blob upload");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      dlog("Blob — source fetch failed, HTTP", res.status, "- keeping hot-linked URL");
      done();
      return imageUrl;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";
    const safeName = query
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    const blob = await put(`product-images/${safeName}.${ext}`, buf, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });
    dlog("Blob — re-hosted permanently at:", blob.url);
    done();
    return blob.url;
  } catch (e) {
    done();
    console.error("[image] blob persist failed, keeping original URL:", e.message);
    return imageUrl;
  }
}

/* ---------------------------------------------------------------
   Handler
--------------------------------------------------------------- */
export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  dlog("──────────────────────────────────────────────");
  dlog("request q =", JSON.stringify(q));

  if (!q) {
    res.status(400).json({ error: "missing query parameter 'q'" });
    return;
  }
  if (q.length > 200) {
    res.status(400).json({ error: "query too long" });
    return;
  }

  const key = cacheKey(q);

  const cached = await readCache(key);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.status(200).json({ ...cached, cached: true, store: REDIS_ENABLED ? "redis" : "memory" });
    return;
  }

  dlog("resolving via providers:", providerConfigSummary());
  const found = await resolveImage(q);
  if (!found) {
    dlog("no image found anywhere for", JSON.stringify(q), `— negative-caching ${NEGATIVE_TTL_SECONDS}s`);
    const negative = { url: null, checkedAt: Date.now() };
    await writeCache(key, negative, NEGATIVE_TTL_SECONDS);
    res.status(200).json({ ...negative, cached: false, store: REDIS_ENABLED ? "redis" : "memory" });
    return;
  }

  dlog("resolved via", found.source, "->", found.url);
  const permanentUrl = await persistToBlob(found.url, q);
  const payload = {
    url: permanentUrl,
    source: found.source,
    title: found.title || q,
    credit: found.credit || null,
    rehosted: BLOB_ENABLED && permanentUrl !== found.url,
    checkedAt: Date.now(),
  };
  await writeCache(key, payload); // permanent (no TTL) — this is now a settled catalog row
  dlog("done — final payload:", JSON.stringify(payload));
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.status(200).json({ ...payload, cached: false, store: REDIS_ENABLED ? "redis" : "memory" });
}