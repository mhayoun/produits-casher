# produits-casher

Recherche multi-critères (Rayon, Catégorie, Sous-catégorie, Marque, Nom du produit, Logo/restriction)
dans la liste des produits sélectionnés casher — Consistoire de Paris, Juillet 2025.

## Développement local

```bash
npm install
npm run dev
```

## Build de production

```bash
npm run build
npm run preview
```

## Déploiement sur Vercel

**Option 1 — via l'interface Vercel**
1. Poussez ce dossier dans un repo GitHub/GitLab/Bitbucket.
2. Sur [vercel.com](https://vercel.com) → "Add New Project" → importez le repo.
3. Vercel détecte automatiquement le framework "Vite" (build `npm run build`, dossier de sortie `dist`). Cliquez "Deploy".

**Option 2 — via la CLI Vercel**
```bash
npm install -g vercel
vercel        # déploiement de preview
vercel --prod # déploiement en production
```

Le fichier `vercel.json` fourni fixe explicitement `buildCommand`, `outputDirectory` et `framework` au cas où
l'auto-détection échouerait.

## Structure

```
produits-casher/
├── index.html          # point d'entrée Vite
├── src/
│   ├── main.jsx         # bootstrap React
│   ├── App.jsx           # logique de filtrage/tri + UI
│   ├── data.js           # données extraites du PDF (source de vérité)
│   └── styles.css        # design tokens + mise en page
├── package.json
├── vite.config.js
└── vercel.json
```

© yelotag.com
