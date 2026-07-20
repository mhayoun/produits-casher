# produits-casher

Recherche multi-critères (Rayon, Catégorie, Sous-catégorie, Marque, Nom du produit, Logo/restriction)
dans la liste des produits sélectionnés casher — Consistoire de Paris, Juillet 2025.

## Développement local (front seul, sans les API `/api/*`)

```bash
npm install
npm run dev
```
Ceci lance uniquement Vite (le front React) sur `http://localhost:5173`. Le dossier `api/` n'est
**pas** servi dans ce mode — les clics sur une carte produit afficheront donc l'état "🔍
Rechercher l'image" (repli manuel), pas les vraies images. Pour ça, voir la section suivante.

## Développement local AVEC les API (recherche d'image réelle + logs)

Le endpoint `/api/image` est une fonction serverless Vercel : il faut la CLI Vercel pour la
servir en local (Vite seul ne le peut pas).

```bash
npm install -g vercel   # une seule fois
vercel link              # relie ce dossier à votre projet Vercel (une seule fois)
vercel env pull .env.local   # récupère les vraies valeurs Upstash/Blob déjà connectées au projet
vercel dev                # démarre front + api/ ensemble, en général sur http://localhost:3000
```

**Voir les logs de l'API en local** : tout `console.log` dans `api/image.js` s'affiche
**directement dans le terminal où tourne `vercel dev`** — pas besoin d'ouvrir le dashboard.
Ouvrez l'app, cliquez sur un produit, et regardez ce terminal : vous verrez pour chaque
variante recherchée la clé de cache, l'endroit exact interrogé (Google CSE / Bing / SerpApi /
Openverse), le résultat trouvé (ou non), les temps de réponse, et l'éventuel upload vers Blob.
Le detail complet du format des logs et l'ordre des fournisseurs sont documentés en tête de
`api/image.js`.

Par défaut ces logs détaillés sont **automatiquement actifs dès que ce n'est pas un déploiement
Production** (donc actifs en local et en Preview). Pour forcer explicitement, ajoutez dans
`.env` / `.env.local` :
```
DEBUG_IMAGES=1   # verbeux même en Production
DEBUG_IMAGES=0   # silencieux même en local (erreurs seulement)
```

**Voir les logs d'une déjà déployée sur Vercel** (Preview ou Production) :
```bash
vercel logs <url-du-déploiement>   # ou : onglet "Logs" / "Functions" du dashboard Vercel
```

## Build de production

```bash
npm run build
npm run preview
```

## Images produit — pipeline serverless (Upstash Redis + Vercel Blob)

En cliquant sur une carte produit, une fenêtre s'ouvre et recherche une image pour chaque
variante du produit (ex. `LINDT Excellence Noir: Doux 85%/70%, Mini Noir 85%/70%, Noir Absolu
99%, ...` devient 6 recherches indépendantes). C'est **`GET /api/image?q=...`** (voir
`api/image.js`) qui répond, avec l'approche base de données décrite.

### Ordre dans lequel une image est cherchée (le premier trouvé gagne)

1. **Cache Redis (Upstash)** — toujours vérifié en premier, quelle que soit la configuration.
   Cache hit → réponse immédiate, aucun appel externe.
2. **Google Programmable Search** (`GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`), si configuré — voir
   ci-dessous pour le restreindre aux photos officielles du Consistoire.
3. **Bing Image Search v7** (`BING_IMAGE_SEARCH_KEY`), si configuré.
4. **SerpApi / Google Images** (`SERPAPI_KEY`), si configuré.
5. **Openverse** (gratuit, sans clé) — toujours disponible, dernier recours.

L'image trouvée est ensuite **re-téléchargée et re-uploadée dans Vercel Blob** (stockage objet
permanent) au lieu d'être hot-linkée, puis la ligne `{ url, source, title }` est écrite
**définitivement** dans Redis et renvoyée au client, qui la met aussi en cache localStorage
(`src/lib/imageClient.js`) pour un accès instantané aux prochaines ouvertures.

Résultat : chaque produit n'est résolu **qu'une seule fois, tous visiteurs confondus** — aucun
quota de recherche n'est jamais consommé côté client, et un futur dashboard d'administration
pourra réécrire directement les lignes Redis pour forcer/corriger une image.

### Chercher d'abord sur www.consistoire.org/images/produits/*

Oui — mettez Google Programmable Search en position n°2 (déjà le cas) et restreignez-le au site
du Consistoire, deux façons possibles (cumulables) :

1. **Recommandé — configurer le moteur lui-même** sur
   [programmablesearchengine.google.com](https://programmablesearchengine.google.com) :
   - "Sites to search" → ajoutez `www.consistoire.org/images/produits/*`
   - désactivez "Search the entire web"
   - activez "Image search"
   - copiez la clé API et le "Search engine ID" (cx) dans `GOOGLE_CSE_KEY` / `GOOGLE_CSE_CX`.
   Cette recherche devient alors *exclusivement* les images du Consistoire.
2. **Filet de sécurité en code** — laissez le moteur chercher plus large mais forcez quand même
   un `site:` à chaque requête en définissant :
   ```
   GOOGLE_CSE_SITE=site:www.consistoire.org/images/produits
   ```
   (voir `.env.example`). Si aucune image n'existe sur ce site pour une variante donnée, le
   pipeline retombe automatiquement sur Bing / SerpApi / Openverse à l'étape suivante.

### Configuration

Copiez `.env.example` en `.env` (local) ou renseignez les mêmes variables dans Vercel → Project
Settings → Environment Variables. Le plus simple sur Vercel : ajoutez les intégrations
**Upstash** (ou **KV**) et **Blob** depuis l'onglet "Storage" du projet, puis connectez-les à ce
projet — les variables `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (ou
`KV_REST_API_URL` / `KV_REST_API_TOKEN`) et `BLOB_READ_WRITE_TOKEN` sont alors injectées
automatiquement, sans rien coder, **quel que soit le nom que vous avez donné à ces stores** dans
le dashboard (ex. `upstash-kv-amethyst-prism`, `produits-casher-blob`) — le nom affiché
n'influence pas le nom des variables d'environnement. Sans ces variables, l'endpoint fonctionne
quand même (cache mémoire par instance + Openverse + hot-link direct), utile en développement.

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
