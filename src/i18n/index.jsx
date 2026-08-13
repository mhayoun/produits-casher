import React, { createContext, useContext, useMemo, useState, useEffect } from "react";
import { STRINGS } from "./strings.js";
import { CATEGORY_EN, CATEGORY_HE } from "./categoryDict.js";

const LANG_STORAGE_KEY = "pc_lang";
const VALID_LANGS = ["fr", "en", "he"];
const RTL_LANGS = new Set(["he"]);
const LOCALE_TAGS = { fr: "fr-FR", en: "en-US", he: "he-IL" };
const CATEGORY_DICTS = { en: CATEGORY_EN, he: CATEGORY_HE };
const TITLES = {
  fr: "produits-casher — Liste des produits sélectionnés",
  en: "produits-casher — List of certified kosher products",
  he: "produits-casher — רשימת המוצרים הכשרים המאושרים",
};

// A Rayon/Catégorie/Sous-catégorie value is either a single segment
// ("Boissons") or several joined by " > " ("Eaux de vie > Gin"). Each atomic
// segment is translated independently via the per-language dictionary —
// segments that repeat under several different parents (e.g. "Gin",
// "Nature") are only stored once — and segments missing from the
// dictionary fall back to French.
export function translateCategoryPath(value, lang) {
  const dict = CATEGORY_DICTS[lang];
  if (!value || !dict) return value;
  return value
    .split(">")
    .map((part) => {
      const trimmed = part.trim();
      return dict[trimmed] || trimmed;
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
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return VALID_LANGS.includes(stored) ? stored : "fr";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
    document.title = TITLES[lang];
  }, [lang]);

  const value = useMemo(() => {
    const dict = STRINGS[lang];
    const t = (key, ...args) => {
      const entry = dict[key];
      return typeof entry === "function" ? entry(...args) : entry;
    };
    const tr = (categoryValue) => translateCategoryPath(categoryValue, lang) || categoryValue;
    const tagLabel = (code) => dict.tagLabels[code] || code;
    const filterLabel = (key) => dict.filterLabels[key] || key;
    const sortLabel = (key) => dict.sortLabels[key] || key;
    const localeTag = LOCALE_TAGS[lang];
    const dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
    return { lang, setLang, dir, t, tr, tagLabel, filterLabel, sortLabel, localeTag };
  }, [lang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within a LangProvider");
  return ctx;
}

const LANG_BUTTONS = [
  { key: "fr", display: "FR" },
  { key: "en", display: "EN" },
  { key: "he", display: "עב" },
];

export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Language / Langue / שפה">
      {LANG_BUTTONS.map((b) => (
        <button
          key={b.key}
          type="button"
          className={"lang-switch-btn" + (lang === b.key ? " is-active" : "")}
          onClick={() => setLang(b.key)}
        >
          {b.display}
        </button>
      ))}
    </div>
  );
}
