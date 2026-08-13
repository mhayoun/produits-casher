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

/**
 * Render `pageNumber` (1-based) onto `canvas`, then draw a yellow highlight
 * over any text on the page matching one of `terms` (tried independently,
 * case/accent-insensitive substring match against the page's text layer).
 * Returns true if at least one term was located and highlighted.
 */
export async function renderPdfPageWithHighlight(canvas, pageNumber, terms, scale = 1.8) {
  const pdf = await getPdfDoc();
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

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

  let found = false;
  ctx.save();
  ctx.fillStyle = "rgba(255, 224, 51, 0.6)";
  for (const term of terms) {
    const needle = normalize(term);
    if (!needle) continue;
    const idx = corpus.indexOf(needle);
    if (idx === -1) continue;
    const endIdx = idx + needle.length;
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
