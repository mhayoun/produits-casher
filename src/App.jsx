import React, { useState, useMemo, useEffect } from "react";
import { PRODUCTS, REMOVED_PRODUCTS } from "./data.js";
import { fetchProductImage } from "./lib/imageClient.js";

/* ---------------------------------------------------------------
   1. FLATTENING — transforme les entrées groupées (PRODUCTS) en
   lignes "produit" individuelles avec Rayon / Catégorie /
   Sous-catégorie / Marque / Nom produit / Logos-restrictions
--------------------------------------------------------------- */
const TAG_RE = /\((EL|SG|SL|L|N|B|V)\)/g;
const TAG_LABELS = {
  L: "Lait (non surveillé)",
  EL: "Équipement lait (parvé)",
  N: "Nouveau produit",
  B: "Bio",
  SG: "Sans gluten",
  SL: "Sans lactose",
  V: "Végan",
  SUPPRIME: "Supprimé de la liste",
};
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
const FILTER_DEFS = [
  { key: "rayon", label: "Rayon", getValue: (r) => r.rayon },
  { key: "categorie", label: "Catégorie", getValue: (r) => r.categorie },
  { key: "sousCategorie", label: "Sous-catégorie", getValue: (r) => r.sousCategorie },
  { key: "marque", label: "Marque", getValue: (r) => r.marque },
  { key: "produit", label: "Nom du produit", getValue: (r) => r.produit },
  { key: "logo", label: "Logo / restriction", getValue: (r) => r.logos, multi: true },
];

const SORT_OPTIONS = [
  { key: "default", label: "Pertinence (ordre du document)" },
  { key: "categorie", label: "Catégorie (A → Z)" },
  { key: "sousCategorie", label: "Sous-catégorie (A → Z)" },
  { key: "marque", label: "Marque (A → Z)" },
  { key: "logo", label: "Logo / restriction" },
];

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

function computeOptions(filters, def) {
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
      label: def.key === "logo" ? TAG_LABELS[value] || value : value,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "fr"));
}

/* ---------------------------------------------------------------
   3. UI helpers
--------------------------------------------------------------- */
function LogoBadge({ code }) {
  return (
    <span className={"badge badge-" + code} title={TAG_LABELS[code] || code}>
      {code}
    </span>
  );
}

function ProductCard({ row, compact, onOpen }) {
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
          {row.removed && <span className="badge badge-SUPPRIME">Suppr.</span>}
          {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
            <LogoBadge key={l} code={l} />
          ))}
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
      title="Voir les images de ce produit"
    >
      <div className="product-card-crumb">
        {row.rayon} <span className="crumb-sep">›</span> {row.categorie}
        {row.sousCategorie && row.sousCategorie !== row.categorie ? (
          <>
            {" "}
            <span className="crumb-sep">›</span> {row.sousCategorie}
          </>
        ) : null}
      </div>
      <div className="product-card-main">
        <div className="product-card-title">
          <span className="product-card-brand">{row.marque}</span>
          <span className="product-card-name">{row.produit}</span>
        </div>
        <div className="product-card-badges">
          {row.removed && <span className="badge badge-SUPPRIME">Supprimé</span>}
          {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
            <LogoBadge key={l} code={l} />
          ))}
        </div>
      </div>
      {row.note && <div className="product-card-note">{row.note}</div>}
      <div className="product-card-hint">🖼️ Voir les images</div>
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
          <a href={searchUrl} target="_blank" rel="noreferrer" title={label}>
            <img src={state.url} alt={label} loading="lazy" />
          </a>
        )}
        {!state.loading && !state.url && (
          <a className="variant-fallback" href={searchUrl} target="_blank" rel="noreferrer">
            🔍<span>Rechercher l'image</span>
          </a>
        )}
      </div>
      <div className="variant-label">{label}</div>
      {state.source && <div className="variant-source">via {state.source.replace("_", " ")}</div>}
    </div>
  );
}

function ProductImageModal({ row, onClose }) {
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
              {row.rayon} <span className="crumb-sep">›</span> {row.categorie}
              {row.sousCategorie && row.sousCategorie !== row.categorie ? (
                <>
                  {" "}
                  <span className="crumb-sep">›</span> {row.sousCategorie}
                </>
              ) : null}
            </div>
            <h3>{row.marque}</h3>
            <div className="modal-badges">
              {row.removed && <span className="badge badge-SUPPRIME">Supprimé</span>}
              {row.logos.filter((l) => l !== "SUPPRIME").map((l) => (
                <LogoBadge key={l} code={l} />
              ))}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>
        {row.note && <p className="modal-note">{row.note}</p>}
        <div className="modal-image-grid">
          {variants.map((v, i) => (
            <VariantImage key={row.id + "-" + i} query={`${row.marque} ${v}`} label={v} />
          ))}
        </div>
        {overflow > 0 && (
          <div className="modal-overflow-note">+ {overflow} autres variantes non affichées</div>
        )}
        <div className="modal-footer">
          Images recherchées et mises en cache automatiquement via l'API serverless
          (Upstash Redis + Vercel Blob) — chaque produit n'est résolu qu'une seule fois pour
          tous les visiteurs.
        </div>
      </div>
    </div>
  );
}

/* Accordion section for one filter, with checkbox multi-select */
function FilterSection({ def, filters, setFilters, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const options = useMemo(() => computeOptions(filters, def), [filters]);
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
      <button className="accordion-head" onClick={() => setOpen((o) => !o)}>
        <span className="accordion-head-left">
          <span className="chevron">{open ? "−" : "+"}</span>
          <span className="accordion-title">{def.label}</span>
          {selected.size > 0 && <span className="count-pill">{selected.size}</span>}
        </span>
        {selected.size > 0 && (
          <span className="reset-link" onClick={resetThis}>
            réinitialiser
          </span>
        )}
      </button>
      {open && (
        <div className="accordion-body">
          {options.length === 0 && <div className="no-options">Aucune option disponible</div>}
          {options.map((opt) => (
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
  return (
    <div className="filters-panel">
      <div className="filters-panel-header">
        <h2>Filtres</h2>
        {totalActive > 0 && (
          <button className="reset-all-btn" onClick={resetAll}>
            Tout réinitialiser ({totalActive})
          </button>
        )}
      </div>
      {FILTER_DEFS.map((def, i) => (
        <FilterSection key={def.key} def={def} filters={filters} setFilters={setFilters} defaultOpen={i === 0} />
      ))}
    </div>
  );
}

function SortSelect({ sortKey, setSortKey }) {
  return (
    <label className="sort-select">
      <span>Trier par</span>
      <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActiveChips({ filters, setFilters }) {
  const chips = [];
  FILTER_DEFS.forEach((def) => {
    filters[def.key].forEach((val) => {
      chips.push({ key: def.key, val, label: def.label });
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
  return (
    <div className="active-chips">
      {chips.map((c, i) => (
        <span className="chip" key={c.key + c.val + i}>
          <span className="chip-label">{c.label}:</span> {c.val}
          <button className="chip-x" onClick={() => remove(c.key, c.val)} aria-label="retirer">
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
  const [filters, setFilters] = useState(emptyFilters());
  const [sortKey, setSortKey] = useState("default");
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 900 : false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedProduct, setSelectedProduct] = useState(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filters, sortKey]);

  useEffect(() => {
    document.body.style.overflow = isMobile && sheetOpen ? "hidden" : selectedProduct ? "hidden" : "";
  }, [isMobile, sheetOpen, selectedProduct]);

  const filteredResults = useMemo(() => FLAT.filter((r) => matchesFilters(r, filters, null)), [filters]);
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
              <div className="brand-sub">Liste des produits sélectionnés — Consistoire de Paris, Juillet 2025</div>
            </div>
          </div>
          {isMobile && (
            <button className="filters-btn-mobile" onClick={() => setSheetOpen(true)}>
              Filtres{totalActive > 0 ? " · " + totalActive : ""}
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
                <strong>{results.length.toLocaleString("fr-FR")}</strong> produit{results.length > 1 ? "s" : ""}{" "}
                trouvé
                {results.length > 1 ? "s" : ""}
                {totalActive > 0 && (
                  <button className="inline-reset" onClick={resetAll}>
                    effacer les {totalActive} filtre{totalActive > 1 ? "s" : ""}
                  </button>
                )}
              </div>
              <SortSelect sortKey={sortKey} setSortKey={setSortKey} />
            </div>

            <ActiveChips filters={filters} setFilters={setFilters} />

            {results.length === 0 ? (
              <div className="empty-state">
                Aucun produit ne correspond à cette combinaison de filtres.
                <br />
                <button className="reset-all-btn" onClick={resetAll}>
                  Réinitialiser tous les filtres
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
                      Afficher {Math.min(PAGE_SIZE, results.length - visibleCount)} produits de plus (
                      {visibleCount} / {results.length})
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      )}

      <footer className="site-footer">
        <div>
          Document source : Liste des Produits Sélectionnés, ACIP / Consistoire de Paris Île-de-France — usage privé,
          cercle de famille. Vérifiez toujours les mentions et codes indiqués sur l'emballage.
        </div>
        <div className="copyright">© yelotag.com</div>
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
  return (
    <div className="mobile-split">
      <div className="mobile-split-filters">
        <div className="filters-panel-header">
          <h2>Filtres</h2>
          <div className="mobile-split-header-actions">
            {totalActive > 0 && (
              <button className="reset-all-btn" onClick={resetAll}>
                Tout réinitialiser ({totalActive})
              </button>
            )}
            <button className="sheet-close" onClick={onClose}>
              Fermer ✕
            </button>
          </div>
        </div>
        <ActiveChips filters={filters} setFilters={setFilters} />
        {FILTER_DEFS.map((def, i) => (
          <FilterSection key={def.key} def={def} filters={filters} setFilters={setFilters} defaultOpen={i === 0} />
        ))}
      </div>

      <div className="mobile-split-results">
        <div className="mobile-split-results-head">
          <strong>{results.length.toLocaleString("fr-FR")}</strong> produit{results.length > 1 ? "s" : ""} trouvé
          {results.length > 1 ? "s" : ""}
          <button className="sheet-cta-mini" onClick={onClose}>
            Voir la liste complète
          </button>
        </div>
        <div className="mobile-split-results-list">
          {results.length === 0 ? (
            <div className="empty-state-mini">Aucun résultat</div>
          ) : (
            results.slice(0, 40).map((r) => <ProductCard key={r.id} row={r} compact onOpen={onOpenProduct} />)
          )}
          {results.length > 40 && (
            <div className="empty-state-mini">… et {results.length - 40} autres, fermez pour tout voir</div>
          )}
        </div>
      </div>
    </div>
  );
}
