/**
 * Renders a page of public/Produits2025-2026.pdf onto a <canvas>, with a
 * yellow highlight drawn directly over the matching text (marque / nom du
 * produit) — the mark lives on the rendered PDF page itself, not as
 * separate app UI styling.
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfjsLibPromise = null;
async function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

let pdfDocPromise = null;
async function getPdfDoc() {
  if (!pdfDocPromise) {
    const pdfjsLib = await loadPdfjs();
    pdfDocPromise = pdfjsLib.getDocument({ url: "/Produits2025-2026.pdf" }).promise;
  }
  return pdfDocPromise;
}

// Same (EL)/(SG)/(SL)/(L)/(N)/(B)/(V) tag markers the catalog (src/data.js /
// App.jsx) strips out of item text — the PDF's own text layer still has
// them inline (e.g. "BLÉDINE (SG) Nature"), so both sides must drop them
// the same way or a search term never lines up with the page text.
function stripCatalogTags(s) {
  return String(s || "")
    .replace(/\((EL|SG|SL|L|N|B|V)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(s) {
  return stripCatalogTags(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Convert a pdf.js text item's PDF-space position to a viewport-space
// (canvas pixel) rectangle {x, y, width, height}, handling the PDF↔canvas
// vertical flip and any page rotation via viewport.convertToViewportPoint.
function itemViewportRect(viewport, item) {
  const x1 = item.transform[4];
  const y1 = item.transform[5];
  const x2 = x1 + item.width;
  const y2 = y1 + item.height;
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
  const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
  const x = Math.min(vx1, vx2);
  const y = Math.min(vy1, vy2);
  return { x, y, width: Math.abs(vx2 - vx1), height: Math.abs(vy2 - vy1) };
}

function findAllOccurrences(haystack, needle) {
  const positions = [];
  if (!needle) return positions;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

// How far (in normalized characters) the product text is allowed to be from
// its brand heading before we no longer trust the pairing. A catalog entry's
// brand and item text always sit right next to each other in the PDF, so a
// short window is enough — and it's what keeps a generic product name like
// "Nature" (which repeats many times per page across different brands) from
// getting matched to some unrelated brand's "Nature" elsewhere on the page.
const PROXIMITY_WINDOW = 400;

/**
 * Render `pageNumber` (1-based) onto `canvas`, then draw a yellow highlight
 * over the marque/produit text on that page. When both are given, only a
 * marque occurrence with the produit text shortly after it counts as a
 * match — a plain "does this text exist anywhere on the page" search isn't
 * enough for common product names ("Nature", "Complet", ...) that repeat
 * under several different brands on the same page.
 * Returns true if a match was located and highlighted.
 *
 * `cancelToken`, if given, is mutated to expose a `.cancel()` that aborts
 * the in-flight page render. React 18 StrictMode invokes effects twice in
 * dev — without cancelling the first render, its `page.render()` call and
 * the second invocation's would both target the same <canvas>, and pdf.js
 * throws ("Cannot use the same canvas during multiple render() operations").
 * The caller's effect cleanup should call `cancelToken.cancel()`.
 *
 * `cancel` is wired up synchronously, before any `await`, precisely because
 * StrictMode's cleanup can run in the same synchronous tick as the effect
 * that scheduled this call — if `.cancel` were only assigned after an
 * async gap (e.g. once `page.render()` starts), a cleanup that fires
 * before that point would be a no-op and both renders would still race.
 */
export async function renderPdfPageWithHighlight(
  canvas,
  pageNumber,
  marqueTerm,
  produitTerm,
  scale = 1.8,
  cancelToken = {}
) {
  cancelToken.cancelled = false;
  cancelToken.cancel = () => {
    cancelToken.cancelled = true;
    if (cancelToken._task) cancelToken._task.cancel();
  };

  const pdf = await getPdfDoc();
  if (cancelToken.cancelled) return false;
  const page = await pdf.getPage(pageNumber);
  if (cancelToken.cancelled) return false;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx, viewport });
  cancelToken._task = renderTask;
  if (cancelToken.cancelled) {
    renderTask.cancel();
    return false;
  }
  await renderTask.promise;
  if (cancelToken.cancelled) return false;

  const textContent = await page.getTextContent();
  // Drop items that carry no real text once catalog tags like "(SG)" are
  // stripped — the PDF often gives those their own text-showing item, and
  // leaving them in would inject extra separator spaces into the corpus
  // (e.g. "blédine    nature" instead of "blédine nature"), breaking the
  // exact substring match against a search term.
  const items = textContent.items.filter((it) => normalize(it.str).length > 0);

  let corpus = "";
  const itemStarts = [];
  for (const it of items) {
    itemStarts.push(corpus.length);
    corpus += normalize(it.str) + " ";
  }

  const marqueNeedle = normalize(marqueTerm);
  const produitNeedle = normalize(produitTerm);
  const marquePositions = findAllOccurrences(corpus, marqueNeedle);
  const produitPositions = findAllOccurrences(corpus, produitNeedle);

  // Prefer the closest (marque → produit) pair; fall back to whichever
  // standalone term was found if no such pair exists on this page.
  let ranges = [];
  let bestGap = Infinity;
  for (const mIdx of marquePositions) {
    for (const pIdx of produitPositions) {
      const gap = pIdx - mIdx;
      if (gap >= 0 && gap <= PROXIMITY_WINDOW && gap < bestGap) {
        bestGap = gap;
        ranges = [
          [mIdx, mIdx + marqueNeedle.length],
          [pIdx, pIdx + produitNeedle.length],
        ];
      }
    }
  }
  if (ranges.length === 0) {
    if (marquePositions.length) ranges.push([marquePositions[0], marquePositions[0] + marqueNeedle.length]);
    if (produitPositions.length) ranges.push([produitPositions[0], produitPositions[0] + produitNeedle.length]);
  }

  let found = false;
  ctx.save();
  ctx.fillStyle = "rgba(46, 204, 90, 0.55)";
  for (const [idx, endIdx] of ranges) {
    for (let i = 0; i < items.length; i++) {
      const start = itemStarts[i];
      const end = start + normalize(items[i].str).length;
      if (end > idx && start < endIdx) {
        found = true;
        const r = itemViewportRect(viewport, items[i]);
        ctx.fillRect(r.x - 2, r.y - 1, r.width + 4, r.height + 2);
      }
    }
  }
  ctx.restore();

  return found;
}
