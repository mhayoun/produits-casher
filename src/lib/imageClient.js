/**
 * Client-side helper for the serverless image pipeline (/api/image).
 *
 * The server (Upstash Redis + Vercel Blob, see api/image.js) is the source of truth and is
 * shared across every visitor. This module only adds a thin localStorage layer so that
 * re-opening a product you already looked at doesn't even need a network round-trip.
 */
const LS_PREFIX = "pc_img_cache_v2:";
const LS_FRESH_MS = 1000 * 60 * 60 * 12; // 12h — after that, re-check with the server in the background

function normalize(query) {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

function readLocal(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ...value, _storedAt: Date.now() }));
  } catch {
    /* localStorage unavailable/full — degrade silently, server cache still works */
  }
}

/**
 * Resolve a product-image query.
 * Returns: { url: string|null, source?, title?, cached?: boolean, error?: boolean }
 */
export async function fetchProductImage(query) {
  const key = normalize(query);
  const local = readLocal(key);
  if (local && Date.now() - (local._storedAt || 0) < LS_FRESH_MS) {
    return local;
  }

  try {
    const res = await fetch("/api/image?q=" + encodeURIComponent(query));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    writeLocal(key, data);
    return data;
  } catch (e) {
    // Network / API route unavailable (e.g. running `vite dev` without `vercel dev`).
    if (local) return local; // serve stale local copy if we have one
    return { url: null, error: true };
  }
}
