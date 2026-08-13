import React, { createContext, useContext, useMemo, useState, useEffect } from "react";
import { STRINGS } from "./strings.js";
import { CATEGORY_EN } from "./categoryDict.js";

const LANG_STORAGE_KEY = "pc_lang";

// A Rayon/Catégorie/Sous-catégorie value is either a single segment
// ("Boissons") or several joined by " > " ("Eaux de vie > Gin"). Each atomic
// segment is translated independently via CATEGORY_EN — segments that repeat
// under several different parents (e.g. "Gin", "Nature") are only stored
// once — and segments missing from the dictionary fall back to French.
export function translateCategoryPath(value) {
  if (!value) return value;
  return value
    .split(">")
    .map((part) => {
      const trimmed = part.trim();
      return CATEGORY_EN[trimmed] || trimmed;
    })
    .join(" > ");
}

// Pure (non-hook) helpers for use in module-level functions like
// computeOptions/sortResults, which run outside a component and receive
// `lang` as a plain argument instead of reading it from context.
export function tagLabelFor(code, lang) {
  return STRINGS[lang].tagLabels[code] || code;
}

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => {
    if (typeof window === "undefined") return "fr";
    return window.localStorage.getItem(LANG_STORAGE_KEY) === "en" ? "en" : "fr";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    document.title =
      lang === "en"
        ? "produits-casher — List of certified kosher products"
        : "produits-casher — Liste des produits sélectionnés";
  }, [lang]);

  const value = useMemo(() => {
    const dict = STRINGS[lang];
    const t = (key, ...args) => {
      const entry = dict[key];
      return typeof entry === "function" ? entry(...args) : entry;
    };
    const tr = (categoryValue) => (lang === "en" ? translateCategoryPath(categoryValue) : categoryValue);
    const tagLabel = (code) => dict.tagLabels[code] || code;
    const filterLabel = (key) => dict.filterLabels[key] || key;
    const sortLabel = (key) => dict.sortLabels[key] || key;
    const localeTag = lang === "en" ? "en-US" : "fr-FR";
    return { lang, setLang, t, tr, tagLabel, filterLabel, sortLabel, localeTag };
  }, [lang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within a LangProvider");
  return ctx;
}

export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Language / Langue">
      <button
        type="button"
        className={"lang-switch-btn" + (lang === "fr" ? " is-active" : "")}
        onClick={() => setLang("fr")}
      >
        FR
      </button>
      <button
        type="button"
        className={"lang-switch-btn" + (lang === "en" ? " is-active" : "")}
        onClick={() => setLang("en")}
      >
        EN
      </button>
    </div>
  );
}
