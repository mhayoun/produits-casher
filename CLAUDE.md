# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page React app (French) that lets users search/filter the "Liste des Produits Sélectionnés" (kosher-certified products list) published by the Consistoire de Paris. Multi-criteria filtering (Rayon / Catégorie / Sous-catégorie / Marque / Nom du produit / Logo-restriction) over a static, hand-maintained product catalog, plus a serverless product-image lookup pipeline.

## Commands

```bash
npm install
npm run dev       # Vite only, front-end at http://localhost:5173 — /api/* NOT served (see below)
npm run build     # production build to dist/
npm run preview   # preview the production build
```

There is no test suite and no linter configured in this repo.

### Running with the `/api/image` serverless function locally

Vite alone cannot serve `api/`. To get real image search + logs locally, use the Vercel CLI instead of `npm run dev`:

```bash
npm install -g vercel
vercel link                   # once, links this folder to the Vercel project
vercel env pull .env.local    # pulls real Upstash/Blob values already connected to the project
vercel dev                    # serves front + api/ together, usually on http://localhost:3000
```

Without `vercel dev`, clicking a product card falls back to the manual "🔍 Rechercher l'image" state instead of showing a resolved image (`fetchProductImage` in `src/lib/imageClient.js` swallows the fetch failure and returns `{ url: null, error: true }`).

`console.log` output from `api/image.js` prints directly in the `vercel dev` terminal — no dashboard needed. Verbose `[image]` logs are on automatically outside Production (local + Preview); force with `DEBUG_IMAGES=1` (always verbose) or `DEBUG_IMAGES=0` (always quiet) in `.env`/`.env.local`.

## Architecture

### Data flow: static catalog → flattened rows → filters

- `src/data.js` is the **source of truth**: a hand-authored array `PRODUCTS` (plus `REMOVED_PRODUCTS` for delisted items) of grouped entries `{ c: rayon, s: "catégorie > sous-catégorie", b: marque, i: [specialités...], n: note }`. Editing the catalog means editing this file directly — there is no CMS or database for it.
- `src/App.jsx` flattens these groups into individual product rows (`flattenCatalog`) at module load time, one row per `(marque, item)` pair. Inline tags like `(N)`, `(B)`, `(SG)`, `(SL)`, `(L)`, `(EL)`, `(V)` embedded in the free-text item/brand strings are parsed out via `TAG_RE`/`extractTags`/`stripTags` into a `logos` array on each row — the source strings intentionally carry these tags rather than using separate structured fields.
- All faceted filtering (`FILTER_DEFS`), sorting, and the quick-search bar operate on this single flattened, in-memory `FLAT` array — everything is client-side, no pagination/query backend. `computeOptions` recomputes per-filter counts excluding the filter's own current selection, so counts reflect "if I additionally picked X" rather than the already-filtered set.

### Serverless image pipeline (`api/image.js` + `src/lib/imageClient.js`)

Clicking a product card opens a modal that splits a product's combined variant string (e.g. `LINDT Excellence Noir: Doux 85%/70%, Mini Noir 85%/70%`) into individual variants (`splitVariants`) and requests an image per variant via `GET /api/image?q=...`.

Resolution order inside `api/image.js` (first hit wins), fully documented in that file's header comment:
1. **Upstash Redis cache** (`UPSTASH_REDIS_REST_URL`/`_TOKEN`, or `KV_REST_API_URL`/`_TOKEN`) — checked first always. Falls back to a per-instance in-memory `Map` if unset (ephemeral, not shared across instances).
2. **SerpApi** (`SERPAPI_KEY`, Google Images engine) — the only paid provider currently wired up. (Google Custom Search JSON API and Bing were removed — Google closed CSE to new customers.)
3. **Openverse** — keyless, CC-licensed, always available as the last resort.

A found image is re-downloaded and re-uploaded to **Vercel Blob** (`persistToBlob`, requires `BLOB_READ_WRITE_TOKEN`) instead of being hot-linked, then the resolved `{ url, source, title }` is written **permanently** (no TTL) to Redis — every product is resolved once, globally, across all visitors. Misses are negative-cached for 6h (`NEGATIVE_TTL_SECONDS`) so a query without results isn't retried on every load.

A per-instance circuit breaker (`tripBreaker`/`isProviderTripped`, `CIRCUIT_BREAKER_MS`) disables a provider for 10 minutes when the response looks like a config error (401/403, "API not enabled", invalid key) rather than a normal "no results" — see `looksLikeConfigError`.

Client-side, `src/lib/imageClient.js` adds a thin `localStorage` cache (`LS_FRESH_MS` = 12h) in front of the API call purely to avoid a network round-trip on repeat views; the server (Redis) remains the source of truth.

All env vars in this pipeline are optional — with none set, the endpoint still works end-to-end using the in-memory cache and keyless Openverse, useful for local dev without any Vercel storage linked. See `.env.example` for the full list and setup notes (including how to restrict image search to `www.consistoire.org/images/produits/*`).

### Deployment

`vercel.json` pins `buildCommand`/`outputDirectory`/`framework` explicitly (Vite auto-detection fallback). Deploy via the Vercel dashboard (auto-detects Vite) or `vercel` / `vercel --prod`.
