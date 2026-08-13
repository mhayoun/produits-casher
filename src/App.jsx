import React, { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { PRODUCTS, REMOVED_PRODUCTS } from "./data.js";
import { fetchProductImage } from "./lib/imageClient.js";
import { renderPdfPageWithHighlight } from "./lib/pdfHighlight.js";
import { useLang, LangSwitch, tagLabelFor, translateCategoryPath } from "./i18n/index.jsx";

/* ---------------------------------------------------------------
   1. FLATTENING — transforme les entrées groupées (PRODUCTS) en
   lignes "produit" individuelles avec Rayon / Catégorie /
   Sous-catégorie / Marque / Nom produit / Logos-restrictions
--------------------------------------------------------------- */
const PDF_URL = "/Produits2025-2026.pdf";
function pdfPageUrl(page) {
  return `${PDF_URL}#page=${page}`;
}

const TAG_RE = /\((EL|SG|SL|L|N|B|V)\)/g;
const TAG_ORDER = ["N", "B", "V", "SG", "SL", "L", "EL", "SUPPRIME"];

function extractTags(text) {
  const found = new Set();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) found.add(m[1]);
  return found;
}
function stripTags(text) {
  return text
    .replace(TAG_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .trim();
}

// Accent/case-insensitive normalization used by both the global quick-search
// bar and the per-filter "search within options" boxes.
function normalizeSearch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function flattenCatalog(groups, removedGroups) {
  const rows = [];
  let id = 0;
  const process = (list, removed) => {
    list.forEach((g) => {
      const parts = g.s.split(">").map((p) => p.trim());
      const categorie = parts[0] || "Divers";
      const sousCategorie = parts.length > 1 ? parts.slice(1).join(" > ") : parts[0];
      (g.i || []).forEach((rawItem) => {
        const combined = (g.b || "") + " " + rawItem;
        const tags = extractTags(combined);
        if (removed) tags.add("SUPPRIME");
        const marque = stripTags(g.b || "Toutes marques");
        const produit = stripTags(rawItem) || marque;
        rows.push({
          id: id++,
          rayon: g.c,
          categorie,
          sousCategorie,
          marque,
          produit,
          logos: TAG_ORDER.filter((t) => tags.has(t)),
          note: g.n || "",
          removed: !!removed,
          page: g.p || null,
        });
      });
    });
  };
  process(groups, false);
  process(removedGroups, true);
  return rows;
}

const FLAT = flattenCatalog(PRODUCTS, REMOVED_PRODUCTS);

/* ---------------------------------------------------------------
   2. Config des filtres, dans l'ordre demandé
--------------------------------------------------------------- */
// Display labels for these keys live in src/i18n/strings.js (filterLabels /
// sortLabels) so they can switch with the language — these configs stay
// language-neutral.
const FILTER_DEFS = [
  { key: "rayon", getValue: (r) => r.rayon },
  { key: "categorie", getValue: (r) => r.categorie },
  { key: "sousCategorie", getValue: (r) => r.sousCategorie },
  { key: "marque", getValue: (r) => r.marque },
  { key: "produit", getValue: (r) => r.produit },
  { key: "logo", getValue: (r) => r.logos, multi: true },
];

const SORT_OPTIONS = ["default", "categorie", "sousCategorie", "marque", "logo"];

function sortResults(results, sortKey) {
  if (sortKey === "default") return results;
  const arr = [...results];
  arr.sort((a, b) => {
    if (sortKey === "logo") {
      const la = a.logos[0] || "zzzz";
      const lb = b.logos[0] || "zzzz";
      return la.localeCompare(lb) || a.produit.localeCompare(b.produit, "fr");
    }
    return (
      (a[sortKey] || "").localeCompare(b[sortKey] || "", "fr") ||
      a.marque.localeCompare(b.marque, "fr") ||
      a.produit.localeCompare(b.produit, "fr")
    );
  });
  return arr;
}

const emptyFilters = () => ({
  rayon: new Set(),
  categorie: new Set(),
  sousCategorie: new Set(),
  marque: new Set(),
  produit: new Set(),
  logo: new Set(),
});

function matchesFilters(row, filters, exceptKey) {
  for (const def of FILTER_DEFS) {
    if (def.key === exceptKey) continue;
    const sel = filters[def.key];
    if (!sel || sel.size === 0) continue;
    if (def.multi) {
      const vals = def.getValue(row);
      if (!vals.some((v) => sel.has(v))) return false;
    } else {
      if (!sel.has(def.getValue(row))) return false;
    }
  }
  return true;
}

const CATEGORY_FILTER_KEYS = new Set(["rayon", "categorie", "sousCategorie"]);

function computeOptions(filters, def, lang) {
  const counts = new Map();
  for (const row of FLAT) {
    if (!matchesFilters(row, filters, def.key)) continue;
    if (def.multi) {
      const vals = def.getValue(row);
      const seen = new Set();
      vals.forEach((v) => {
        if (seen.has(v)) return;
        seen.add(v);
        counts.set(v, (counts.get(v) || 0) + 1);
      });
    } else {
      const v = def.getValue(row);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({
      value,
      count,
      label:
        def.key === "logo"
          ? tagLabelFor(value, lang)
          : CATEGORY_FILTER_KEYS.has(def.key)
          ? translateCategoryPath(value, lang) || value
          : value,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, lang === "fr" ? "fr" : lang));
}

/* ---------------------------------------------------------------
   3. UI helpers
--------------------------------------------------------------- */
function PdfHighlightModal({ row, onClose }) {
  const { t } = useLang();
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | found | notfound | error
  const [errorDetail, setErrorDetail] = useState("");
  const [highlightRect, setHighlightRect] = useState(null);

  useEffect(() => {
    let alive = true;
    const cancelToken = {};
    setStatus("loading");
    setErrorDetail("");
    setHighlightRect(null);
    renderPdfPageWithHighlight(canvasRef.current, row.page, row.marque, row.produit, undefined, cancelToken)
      .then(({ found, rect }) => {
        if (!alive) return;
        setStatus(found ? "found" : "notfound");
        setHighlightRect(found ? rect : null);
      })
      .catch((e) => {
        if (!alive) return; // cancelled by cleanup (e.g. React StrictMode's double effect run in dev) — expected
        console.error("[pdf-highlight]", e);
        setErrorDetail((e && (e.message || String(e))) || t("pdfUnknownError"));
        setStatus("error");
      });
    return () => {
      alive = false;
      cancelToken.cancel && cancelToken.cancel();
    };
  }, [row]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Runs after React has committed the "found" status to the DOM (canvas
  // switched from display:none back to visible) — scrolling any earlier,
  // e.g. right inside the render promise's `.then()`, would target a wrap
  // element whose scrollable content is still hidden, and the browser
  // silently clamps the scroll request to 0.
  useEffect(() => {
    if (status !== "found" || !highlightRect || !wrapRef.current) return;
    const wrap = wrapRef.current;
    const targetTop = highlightRect.y + highlightRect.height / 2 - wrap.clientHeight / 2;
    const targetLeft = highlightRect.x + highlightRect.width / 2 - wrap.clientWidth / 2;
    wrap.scrollTo({ top: Math.max(0, targetTop), left: Math.max(0, targetLeft), behavior: "smooth" });
  }, [status, highlightRect]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="pdf-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-modal-header">
          <div className="pdf-modal-title">
            {t("pdfPageTitle", row.page)}
            {status === "found" && <span className="pdf-modal-hint">{t("pdfFoundHint")}</span>}
            {status === "notfound" && <span className="pdf-modal-hint">{t("pdfNotFoundHint")}</span>}
            {status === "error" && <span className="pdf-modal-hint">{t("pdfErrorHint")}</span>}
          </div>
          <div className="pdf-modal-actions">
            <a href={pdfPageUrl(row.page)} target="_blank" rel="noreferrer">
              {t("pdfOpenFull")}
            </a>
            <button className="modal-close" onClick={onClose} aria-label={t("close")}>
              ✕
            </button>
          </div>
        </div>
        <div className="pdf-modal-canvas-wrap" ref={wrapRef}>
          {status === "loading" && <div className="pdf-modal-status">{t("pdfLoading")}</div>}
          {status === "error" && (
            <div className="pdf-modal-status">
              {t("pdfLoadFailed")}
              <div className="pdf-modal-error-detail">{errorDetail}</div>
            </div>
          )}
          {/* dir="ltr" pinned regardless of UI language: pdf.js draws the PDF's
              text with ctx.fillText(), whose direction inherits from the
              canvas's computed CSS direction — under a Hebrew/RTL page that
              silently bidi-reorders the (French) glyphs into garbage. */}
          <canvas
            ref={canvasRef}
            dir="ltr"
            className={status === "loading" || status === "error" ? "is-loading" : ""}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}

function PdfSourceButton({ row, className }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  if (!row || !row.page) return null;
  return (
    <>
      <button
        type="button"
        className={"pdf-source-btn" + (className ? " " + className : "")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={t("pdfSourceBtnTitle", row.page)}
      >
        📄 PDF p.{row.page}
      </button>
      {open && <PdfHighlightModal row={row} onClose={() => setOpen(false)} />}
    </>
  );
}

function LogoBadge({ code }) {
  const { tagLabel } = useLang();
  return (
    <span className={"badge badge-" + code} title={tagLabel(code)}>
      {code}
    </span>
  );
}

function ProductCard({ row, compact, onOpen }) {
  const { t, tr } = useLang();
  if (compact) {
    return (
      <div
        className={"product-row-compact" + (row.removed ? " is-removed" : "")}
        onClick={() => onOpen && onOpen(row)}
        role="button"
        tabIndex={0}
      >
        <div className="pr-c-main">
          <span className="pr-c-brand">{row.marque}</span>
          <span className="pr-c-name">{row.produit}</span>
        </div>
        <div className="pr-c-badges">
          {row.removed && <span className="badge badge-SUPPRIME">{t("removedShort")}</span>}
          {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
            <LogoBadge key={l} code={l} />
          ))}
          <PdfSourceButton row={row} className="pdf-source-btn-compact" />
        </div>
      </div>
    );
  }
  return (
    <div
      className={"product-card" + (row.removed ? " is-removed" : "")}
      onClick={() => onOpen && onOpen(row)}
      role="button"
      tabIndex={0}
      title={t("seeImagesTitle")}
    >
      <div className="product-card-crumb">
        {tr(row.rayon)} <span className="crumb-sep">›</span> {tr(row.categorie)}
        {row.sousCategorie && row.sousCategorie !== row.categorie ? (
          <>
            {" "}
            <span className="crumb-sep">›</span> {tr(row.sousCategorie)}
          </>
        ) : null}
      </div>
      <div className="product-card-main">
        <div className="product-card-title">
          <span className="product-card-brand">{row.marque}</span>
          <span className="product-card-name">{row.produit}</span>
        </div>
        <div className="product-card-badges">
          {row.removed && <span className="badge badge-SUPPRIME">{t("removedFull")}</span>}
          {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
            <LogoBadge key={l} code={l} />
          ))}
        </div>
      </div>
      {row.note && <div className="product-card-note">{row.note}</div>}
      <div className="product-card-footer">
        <div className="product-card-hint">{t("seeImages")}</div>
        <PdfSourceButton row={row} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Images produit — appelle le pipeline serverless (/api/image),
   voir api/image.js : cache Upstash Redis + upload permanent
   Vercel Blob. Un "produit" comme "Excellence Noir: Doux 85%/70%,
   Mini Noir 85%/70%, Noir Absolu 99% ..." est éclaté en variantes
   individuelles, chacune avec sa propre recherche d'image.
--------------------------------------------------------------- */
function splitVariants(produit) {
  let prefix = "";
  let rest = produit;
  const colonIdx = produit.indexOf(":");
  if (colonIdx > -1 && colonIdx < 45) {
    prefix = produit.slice(0, colonIdx).trim();
    rest = produit.slice(colonIdx + 1).trim();
  }
  const parts = rest
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [produit.trim()];
  return parts.map((p) => (prefix ? `${prefix} ${p}` : p));
}

function VariantImage({ query, label }) {
  const { t } = useLang();
  const [state, setState] = useState({ loading: true, url: null, error: false, source: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, url: null, error: false, source: null });
    fetchProductImage(query).then((data) => {
      if (!alive) return;
      setState({ loading: false, url: data && data.url, error: !data || data.error, source: data && data.source });
    });
    return () => {
      alive = false;
    };
  }, [query]);

  const searchUrl = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(query);

  return (
    <div className="variant-card">
      <div className="variant-image-wrap">
        {state.loading && <div className="skeleton" />}
        {!state.loading && state.url && (
          <a href={searchUrl} target="_blank" rel="noreferrer" title={t("variantImgTitle", label)}>
            <img src={state.url} alt={label} loading="lazy" />
            <span className="variant-ai-flag">{t("variantAiFlag")}</span>
          </a>
        )}
        {!state.loading && !state.url && (
          <a className="variant-fallback" href={searchUrl} target="_blank" rel="noreferrer">
            🔍<span>{t("searchImage")}</span>
          </a>
        )}
      </div>
      <div className="variant-label">{label}</div>
      {state.source && <div className="variant-source">{t("viaSource", state.source.replace("_", " "))}</div>}
    </div>
  );
}

function ProductImageModal({ row, onClose }) {
  const { t, tr } = useLang();
  const variants = useMemo(() => splitVariants(row.produit).slice(0, 16), [row]);
  const overflow = splitVariants(row.produit).length - variants.length;

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-crumb">
              {tr(row.rayon)} <span className="crumb-sep">›</span> {tr(row.categorie)}
              {row.sousCategorie && row.sousCategorie !== row.categorie ? (
                <>
                  {" "}
                  <span className="crumb-sep">›</span> {tr(row.sousCategorie)}
                </>
              ) : null}
            </div>
            <h3>{row.marque}</h3>
            <div className="modal-badges">
              {row.removed && <span className="badge badge-SUPPRIME">{t("removedFull")}</span>}
              {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
                <LogoBadge key={l} code={l} />
              ))}
              <PdfSourceButton row={row} />
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label={t("close")}>
            ✕
          </button>
        </div>
        {row.note && <p className="modal-note">{row.note}</p>}
        <div className="modal-ai-warning">{t("aiWarning")}</div>
        <div className="modal-image-grid">
          {variants.map((v, i) => (
            <VariantImage key={row.id + "-" + i} query={`${row.marque} ${v}`} label={v} />
          ))}
        </div>
        {overflow > 0 && <div className="modal-overflow-note">{t("overflowVariants", overflow)}</div>}
        <div className="modal-footer">{t("modalFooter")}</div>
      </div>
    </div>
  );
}

/* Accordion section for one filter, with checkbox multi-select and a
   search-within-options box for long lists (Marque, Nom du produit...) */
function FilterSection({ def, filters, setFilters, isOpen, onToggle }) {
  const { t, lang, filterLabel } = useLang();
  const open = isOpen;
  const [search, setSearch] = useState("");
  const label = filterLabel(def.key);
  const options = useMemo(() => computeOptions(filters, def, lang), [filters, lang]);
  const visibleOptions = useMemo(() => {
    if (!search.trim()) return options;
    const needle = normalizeSearch(search);
    return options.filter((opt) => normalizeSearch(opt.label).includes(needle));
  }, [options, search]);
  const selected = filters[def.key];

  const toggleValue = (value) => {
    setFilters((prev) => {
      const next = { ...prev };
      const s = new Set(prev[def.key]);
      if (s.has(value)) s.delete(value);
      else s.add(value);
      next[def.key] = s;
      return next;
    });
  };
  const resetThis = (e) => {
    e.stopPropagation();
    setFilters((prev) => ({ ...prev, [def.key]: new Set() }));
  };

  return (
    <div className={"accordion-section" + (open ? " is-open" : "")}>
      <button className="accordion-head" onClick={onToggle}>
        <span className="accordion-head-left">
          <span className="chevron">{open ? "−" : "+"}</span>
          <span className="accordion-title">{label}</span>
          {selected.size > 0 && <span className="count-pill">{selected.size}</span>}
        </span>
        {selected.size > 0 && (
          <span className="reset-link" onClick={resetThis}>
            {t("resetThis")}
          </span>
        )}
      </button>
      {open && (
        <div className="accordion-body">
          {options.length > 5 && (
            <input
              type="text"
              className="filter-search-input"
              placeholder={t("searchWithin", label)}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {visibleOptions.length === 0 && (
            <div className="no-options">{options.length === 0 ? t("noOptions") : t("noSearchResults")}</div>
          )}
          {visibleOptions.map((opt) => (
            <label key={opt.value} className="filter-option">
              <input type="checkbox" checked={selected.has(opt.value)} onChange={() => toggleValue(opt.value)} />
              <span className="filter-option-label">
                {def.key === "logo" ? (
                  <>
                    <LogoBadge code={opt.value} /> {opt.label}
                  </>
                ) : (
                  opt.label
                )}
              </span>
              <span className="filter-option-count">{opt.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FiltersPanel({ filters, setFilters, totalActive, resetAll }) {
  const { t } = useLang();
  const [openKey, setOpenKey] = useState(FILTER_DEFS[0].key);
  return (
    <div className="filters-panel">
      <div className="filters-panel-header">
        <h2>{t("filters")}</h2>
        {totalActive > 0 && (
          <button className="reset-all-btn" onClick={resetAll}>
            {t("resetAll", totalActive)}
          </button>
        )}
      </div>
      {FILTER_DEFS.map((def) => (
        <FilterSection
          key={def.key}
          def={def}
          filters={filters}
          setFilters={setFilters}
          isOpen={openKey === def.key}
          onToggle={() => setOpenKey((k) => (k === def.key ? null : def.key))}
        />
      ))}
    </div>
  );
}

function SortSelect({ sortKey, setSortKey }) {
  const { t, sortLabel } = useLang();
  return (
    <label className="sort-select">
      <span>{t("sortBy")}</span>
      <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
        {SORT_OPTIONS.map((key) => (
          <option key={key} value={key}>
            {sortLabel(key)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActiveChips({ filters, setFilters }) {
  const { t, tr, tagLabel, filterLabel } = useLang();
  const chips = [];
  FILTER_DEFS.forEach((def) => {
    filters[def.key].forEach((val) => {
      chips.push({ key: def.key, val, label: filterLabel(def.key) });
    });
  });
  if (chips.length === 0) return null;
  const remove = (key, val) => {
    setFilters((prev) => {
      const next = { ...prev };
      const s = new Set(prev[key]);
      s.delete(val);
      next[key] = s;
      return next;
    });
  };
  const displayVal = (c) => {
    if (c.key === "logo") return tagLabel(c.val);
    if (CATEGORY_FILTER_KEYS.has(c.key)) return tr(c.val);
    return c.val;
  };
  return (
    <div className="active-chips">
      {chips.map((c, i) => (
        <span className="chip" key={c.key + c.val + i}>
          <span className="chip-label">{c.label}:</span> {displayVal(c)}
          <button className="chip-x" onClick={() => remove(c.key, c.val)} aria-label={t("removeAria")}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   4. App
--------------------------------------------------------------- */
const PAGE_SIZE = 60;

export default function App() {
  const { t, localeTag } = useLang();
  const [filters, setFilters] = useState(emptyFilters());
  const [sortKey, setSortKey] = useState("default");
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 900 : false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [quickSearch, setQuickSearch] = useState("");

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filters, sortKey, quickSearch]);

  useEffect(() => {
    document.body.style.overflow = isMobile && sheetOpen ? "hidden" : selectedProduct ? "hidden" : "";
  }, [isMobile, sheetOpen, selectedProduct]);

  const filteredByFacets = useMemo(() => FLAT.filter((r) => matchesFilters(r, filters, null)), [filters]);
  const filteredResults = useMemo(() => {
    if (!quickSearch.trim()) return filteredByFacets;
    const needle = normalizeSearch(quickSearch);
    return filteredByFacets.filter((r) =>
      normalizeSearch(`${r.rayon} ${r.categorie} ${r.sousCategorie} ${r.marque} ${r.produit}`).includes(needle)
    );
  }, [filteredByFacets, quickSearch]);
  const results = useMemo(() => sortResults(filteredResults, sortKey), [filteredResults, sortKey]);

  const totalActive = FILTER_DEFS.reduce((acc, d) => acc + filters[d.key].size, 0);
  const resetAll = () => setFilters(emptyFilters());

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark">✓כ</span>
            <div>
              <div className="brand-name">produits-casher</div>
              <div className="brand-sub">{t("tagline")}</div>
            </div>
          </div>
          <div className="topbar-search">
            <input
              type="text"
              className="quick-search-input"
              placeholder={t("searchPlaceholder")}
              value={quickSearch}
              onChange={(e) => setQuickSearch(e.target.value)}
              aria-label={t("quickSearchAria")}
            />
            {quickSearch && (
              <button
                className="quick-search-clear"
                onClick={() => setQuickSearch("")}
                aria-label={t("clearSearchAria")}
              >
                ✕
              </button>
            )}
          </div>
          <LangSwitch />
          {isMobile && (
            <button className="filters-btn-mobile" onClick={() => setSheetOpen(true)}>
              {t("filtersMobileBtn", totalActive)}
            </button>
          )}
        </div>
      </header>

      {isMobile && sheetOpen ? (
        <MobileSplitView
          filters={filters}
          setFilters={setFilters}
          totalActive={totalActive}
          resetAll={resetAll}
          results={results}
          onClose={() => setSheetOpen(false)}
          onOpenProduct={setSelectedProduct}
        />
      ) : (
        <main className="layout">
          {!isMobile && (
            <aside className="filters-col">
              <FiltersPanel filters={filters} setFilters={setFilters} totalActive={totalActive} resetAll={resetAll} />
            </aside>
          )}

          <section className="results-col">
            <div className="results-summary">
              <div className="results-summary-count">
                <strong>{results.length.toLocaleString(localeTag)}</strong> {t("productsFoundSuffix", results.length)}
                {totalActive > 0 && (
                  <button className="inline-reset" onClick={resetAll}>
                    {t("clearNFilters", totalActive)}
                  </button>
                )}
              </div>
              <SortSelect sortKey={sortKey} setSortKey={setSortKey} />
            </div>

            <ActiveChips filters={filters} setFilters={setFilters} />

            {results.length === 0 ? (
              <div className="empty-state">
                {quickSearch ? (
                  <>
                    {t("noResultsQuery", quickSearch)}
                    {totalActive > 0 ? t("noResultsQueryWithFilters") : ""}.
                  </>
                ) : (
                  t("noResultsPlain")
                )}
                <br />
                <button
                  className="reset-all-btn"
                  onClick={() => {
                    resetAll();
                    setQuickSearch("");
                  }}
                >
                  {t("resetSearchAndFilters", !!quickSearch)}
                </button>
              </div>
            ) : (
              <>
                <div className="product-grid">
                  {results.slice(0, visibleCount).map((r) => (
                    <ProductCard key={r.id} row={r} onOpen={setSelectedProduct} />
                  ))}
                </div>
                {visibleCount < results.length && (
                  <div className="load-more-wrap">
                    <button className="load-more-btn" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                      {t("loadMore", Math.min(PAGE_SIZE, results.length - visibleCount), visibleCount, results.length)}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      )}

      <footer className="site-footer">
        <div>{t("footerLegal")}</div>
        <div className="copyright">
          © <a href="https://www.yelotag.com" target="_blank" rel="noreferrer">yelotag.com</a>
        </div>
      </footer>

      {selectedProduct && (
        <ProductImageModal row={selectedProduct} onClose={() => setSelectedProduct(null)} />
      )}
    </div>
  );
}

/* Mobile split view : 3/4 filtres (haut) + 1/4 résultats en direct (bas),
   visibles en parallèle pendant qu'on coche les filtres. */
function MobileSplitView({ filters, setFilters, totalActive, resetAll, results, onClose, onOpenProduct }) {
  const { t, localeTag } = useLang();
  const [openKey, setOpenKey] = useState(FILTER_DEFS[0].key);
  return (
    <div className="mobile-split">
      <div className="mobile-split-filters">
        <div className="filters-panel-header">
          <h2>{t("filters")}</h2>
          <div className="mobile-split-header-actions">
            {totalActive > 0 && (
              <button className="reset-all-btn" onClick={resetAll}>
                {t("resetAll", totalActive)}
              </button>
            )}
            <button className="sheet-close" onClick={onClose}>
              {t("mobileClose")}
            </button>
          </div>
        </div>
        <ActiveChips filters={filters} setFilters={setFilters} />
        {FILTER_DEFS.map((def) => (
          <FilterSection
            key={def.key}
            def={def}
            filters={filters}
            setFilters={setFilters}
            isOpen={openKey === def.key}
            onToggle={() => setOpenKey((k) => (k === def.key ? null : def.key))}
          />
        ))}
      </div>

      <div className="mobile-split-results">
        <div className="mobile-split-results-head">
          <strong>{results.length.toLocaleString(localeTag)}</strong> {t("productsFoundSuffix", results.length)}
          <button className="sheet-cta-mini" onClick={onClose}>
            {t("mobileSeeFullList")}
          </button>
        </div>
        <div className="mobile-split-results-list">
          {results.length === 0 ? (
            <div className="empty-state-mini">{t("mobileNoResults")}</div>
          ) : (
            results.slice(0, 40).map((r) => <ProductCard key={r.id} row={r} compact onOpen={onOpenProduct} />)
          )}
          {results.length > 40 && (
            <div className="empty-state-mini">{t("mobileMoreResults", results.length - 40)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
