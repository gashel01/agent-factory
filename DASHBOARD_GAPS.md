# Agent Factory — Dashboard gaps & roadmap

État après la refonte visuelle (transposition du prototype "atelier calme"). Trois catégories :
A = fidélité au prototype, B = écarts produit / vraie donnée, C = confort d'usage (au-delà du proto).

Priorité : P0 (bloquant/valeur forte) · P1 (important) · P2 (nice-to-have). Effort : S / M / L.

---

## A. Écarts avec le prototype (design déjà là, éléments non portés ou divergents)

| # | Élément | État actuel | Prio | Effort |
|---|---------|-------------|------|--------|
| A1 | ✅ **FAIT** — Bouton `⋯` sur la carte projet → ProjectEditor (renommer : nouvel endpoint serveur PUT `/api/workspaces/<name>` + `Registry.rename` préservant l'ordre ; budget par projet ; suppression). Dépôt affiché en lecture seule (le dépôt est par-ticket, pas une propriété du workspace). | absent | P1 | M (besoin back) |
| A2 | ✅ **FAIT** — `NewWorkModal` prend une variante `project` : ouvert depuis l'écran projets, il s'intitule « New project » et met la création de workspace (`AddWorkspace`) en tête (section « Create the project » + séparateur « then draft its work below »). Depuis le cockpit, reste « New work » avec l'ajout de workspace en `<details>`. | incohérent | P2 | S |
| A3 | ✅ **FAIT** — Section "Learned from this task" dans la modale d'historique (faits liés au ticket) + "+ Add a lesson" (FactEditor pré-rempli, reload à la sauvegarde) | absente | P1 | M |
| A4 | ✅ **FAIT (partiel)** — Barre d'actions riche de la modale : Answer (bloqué+live) / Try again / Run again / Stop / Add lesson / bascule log brut. **Reste** : Voir le diff (→ B5) et Éditer/Supprimer le ticket (→ A5). | partielle (juste bascule log brut) | P1 | M |
| A5 | ✅ **FAIT** — édition + suppression inline existaient déjà (NewWorkModal, PUT/DELETE `/api/backlog`) ; ajouté **« + New ticket by hand »** qui scaffolde un squelette de front matter (id = numéro libre suivant, repo pré-rempli) et l'ouvre direct dans l'éditeur → création manuelle sans planner IA. Vérifié live. | divergent (on passe par le backlog dans "New work") | P1 | M |
| A6 | ✅ **FAIT** — densité Comfortable / Compact dans la modale Appearance (`data-density` → tighten board/colonnes/cartes). | non exposé | P2 | S |
| A7 | ✅ **FAIT** — accent indigo / teal / orange / violet (pastilles, `data-accent` → `--accent`/`--accent-soft` clair+sombre). Vérifié live (s'applique + persiste). | non exposé | P2 | S |
| A8 | ✅ **FAIT** (version honnête) — badge "used N×" sur chaque fait (carte mémoire + modale d'historique) + total "applied N×" dans la synthèse. Compte les injections réelles dans les prompts (pas de "ré-échecs évités" inventé). | volontairement omis (pas de vraie donnée) | — | dépend de B1 |

## B. Écarts produit / fonctionnalités à brancher sur de la vraie donnée

| # | Fonctionnalité | Pourquoi | Prio | Effort |
|---|----------------|----------|------|--------|
| B1 | ✅ **FAIT** — Mémoire auto-alimentée : "Save lesson" depuis une carte échouée/bloquée (pré-remplie avec la note d'échec), et **injection des leçons pertinentes dans le prompt de l'agent** via `memorymcp` (repli mots-clés sans dépendance). Globales toujours injectées, leçons projet classées par ticket. | c'est le vrai moat : la mémoire ne sert que si elle est appliquée automatiquement | P0 | L |
| B2 | ✅ **FAIT** — Répondre à un agent BLOQUÉ depuis l'UI : modale de réponse → op `answer` (control.jsonl, champ `text`) → le dispatcher ré-enfile la tâche BLOCKED avec la question + la réponse injectées dans le prompt. | aujourd'hui "Répondre" = juste relancer ; on ne transmet pas la réponse | P0 | M |
| B3 | ✅ **FAIT** — Budget réglable **par projet** (ProjectEditor écrit `budget.max_usd` dans le `factory.yaml` du workspace via `/api/config?ws=`, round-trip parseSettings/generateConfig). L'effort était déjà par projet (Settings est ws-scopé). | le portail montre le budget mais on ne peut pas le fixer par projet | P1 | M |
| B4 | ✅ **FAIT** — Retirer un projet depuis l'UI (bouton "Remove project" 2-clics dans ProjectEditor → DELETE existant ; garde-fou dernier workspace). Les fichiers restent sur le disque (registre seulement). | pas de bouton pour retirer un workspace | P1 | S/M |
| B5 | ✅ **FAIT** — "View diff" sur la carte d'un ticket mergé (et dans sa modale d'historique) → `DiffModal` colorisée. Le merge (`--no-ff`) enregistre la plage `base_sha..head_sha` dans l'événement `merged` (+ repo) ; le diff survit à la suppression de la branche (commits atteignables depuis le merge). Rendu via l'endpoint `/api/repo/diff?repo=&from=&to=` existant. Ne s'affiche que pour les runs mergés après ce changement. | on a le Repo + Preview, mais pas lié à un ticket précis | P1 | M |
| B6 | ✅ **FAIT** — vrai compteur d'application des leçons. `LessonStore.recall` renvoie les ids injectés ; le dispatcher les persiste dans `memory.applied.json` (factory = seul writer) ; `/api/memory` fusionne le compte `applied` sur chaque fait. | débloque A8 honnêtement | P2 | M |
| B7 | ✅ **FAIT** — Garde-fou avant run : "Run again" ouvre `RunGuardModal` (nb de tickets à lancer, cap budget en vigueur ou avertissement "pas de cap" + lien Settings, estimation ~$ dérivée du coût moyen/ticket mergé des runs passés). Confirmation explicite avant de dépenser. | éviter les mauvaises surprises de crédits | P1 | M |
| B8 | ✅ **FAIT** — **Mode contrôle** (toggle Settings `approval.manual`). Activé : au lieu de fusionner automatiquement, une tâche finie se gare dans un nouvel état `AWAITING_APPROVAL` (colonne "À valider") jusqu'à validation humaine. Bouton **Valider** (op `approve` → MERGE_QUEUED) ou **Revoir** → LogModal avec barre "Valider et fusionner" / "Demander des changements" (op `changes` + consigne texte → jette la branche, ré-enfile en QUEUED avec la consigne en failure_note). Diff conservé via la plage `base..commit` de l'événement `awaiting_approval`. Backend + client + 4 tests (3 unit control + 1 e2e park→approve→merge). | l'humain reste juge du merge | P1 | L |
| — | ✅ **BUG corrigé au passage** — le save des Settings envoyait un **POST** vers `/api/config` (le serveur ne route que **PUT** → 404 silencieux) : **aucun réglage du panneau Settings ne persistait**. Passé à `fetchJSON` PUT scopé au workspace courant. (Le ProjectEditor utilisait déjà PUT, d'où le fait que le budget par projet marchait.) | | — | S |

## C. Confort d'usage / UX (au-delà du prototype)

| # | Amélioration | Bénéfice | Prio | Effort |
|---|--------------|----------|------|--------|
| C1 | ✅ **FAIT** — Notifications navigateur (bouton cloche 🔔/🔕 dans le header, opt-in + permission OS, persisté). Ne notifie que si l'onglet est en arrière-plan (le toast couvre le premier plan). Transitions DONE/FAILED/BLOCKED + fin de run. | plus besoin de fixer l'écran | P1 | S |
| C2 | ✅ **FAIT** — Toasts sur changements d'état réels (merged/failed/needs-you + fin de run). Fenêtre de grâce 3,5 s pour avaler le replay-à-la-connexion (pas de rafale d'alertes historiques). | feedback vivant | P1 | S |
| C3 | ✅ **FAIT** — Échap ferme tout overlay (hook `useEsc` dans Modal/Drawer/LogModal, gère l'imbrication) ; raccourcis `n` (New work) / `f` (Kanban↔Focus) cockpit-only, jamais en saisie ; anneaux de focus `:focus-visible`. | rapidité + accessibilité | P1 | S/M |
| C4 | ✅ **FAIT** — `Onboarding` sur l'état vide de l'écran projets (0 workspace) : nom + dossier + « repo existant / démarrer à neuf » (repo/init) + stack (node/python/other) + budget → crée le workspace, écrit un `factory.yaml` de base (via `generateConfig` + `PUT /api/config?ws=`), et atterrit dans le cockpit. Zéro terminal. | onboarding sans terminal | P1 | M |
| C5 | ✅ **FAIT** — Barre de filtre au-dessus du board (id / titre / note, apparaît dès >6 tickets, compteur "X of N" + clear). Filtre seulement l'affichage Kanban, la synthèse d'en-tête reste sur tout le run. | utile quand beaucoup de tickets | P2 | S |
| C6 | ✅ **FAIT** — `stream_headless` prend un callback `on_progress(turns, tokens)` (compte les records `assistant`, accumule les tokens d'usage) ; `run_agent` le passe ; le dispatcher émet `agent_progress` (un par tour) ; le client affiche **turn N + tokens live** (champs `liveTurns`/`liveTokens` séparés des totaux autoritatifs, remis à 0 à chaque nouvelle tentative). Le coût $ reste en fin de tentative (honnête : pas de pricing inventé). e2e `test_agent_progress_streams_live`. | transparence temps réel | P2 | M |
| C7 | ✅ **FAIT** — media-query 720px complétée (topbar wrap, **board colonnes empilées** au lieu du scroll horizontal, grilles projet/analytics en 1 colonne, overlays + cmdk pleine largeur) + breakpoint 460px (tuiles 50%, boutons resserrés). | pilotage depuis le téléphone | P2 | M |
| C8 | ✅ **DÉJÀ FAIT** — LogModal n'auto-scrolle que si on est déjà en bas (distance < 80px) ; remonter lire suspend l'auto-scroll de fait. | ne pas perdre sa lecture | P2 | S |
| C9 | ✅ **FAIT** — 3e option "System" (suit l'OS en direct via matchMedia listener), en plus de la bascule rapide clair/sombre. Dans la modale Appearance. | actuellement clair/sombre binaire | P2 | S |
| C10 | ✅ **FAIT** — « Open in IDE » (protocole `vscode://file/<repo>`) sur les cartes qui ont un diff capturé (repo connu), à côté de « View diff » et du « View PR ↗ » déjà présent (prUrl). Vérifié live sur un ticket mergé. | raccourcis vers le vrai travail | P2 | S |

---

## D. Vision next-gen (2026-07-13)

| # | Amélioration | État |
|---|--------------|------|
| D1 | **Coloration syntaxique** (moteur maison `highlight.ts`, zéro CDN, par ligne) dans diffs + preview de fichier | ✅ FAIT |
| D2 | **Diffs repliables multi-fichiers** (`parseDiff`, barre de saut par fichier, section repliable, +/- par fichier) | ✅ FAIT |
| D3 | **Historique chat superviseur persistant** (`.supervisor-chat.jsonl` par workspace, serveur seul writer, survit au reload) | ✅ FAIT |
| D4 | **PÉPITE — commentaires de diff en ligne qui bouclent vers l'agent** (`ReviewModal` : "+" par ligne → remarque épinglée → compile en op `changes`) | ✅ FAIT (vérifié live via stub, zéro token) |
| D5 | **Mode PR-natif** (toggle Settings : au lieu de fusionner en local, `gh pr create` par ticket vérifié → review/merge sur GitHub ; garde-fous absence de `gh`/remote ; **auto-sync de la base** : `fetch` + détection ahead/behind + `pull --ff-only` si en retard, note ⇣/⇡ dans le dashboard) | ✅ FAIT (sync vérifié live via stub ; PR guards unit-testés) |
| D6 | **DevOps — vérification d'intégration post-run** (après toutes les fusions, la suite complète tourne UNE fois sur la branche d'intégration ; bannière verte/rouge + échecs). Reste optionnel : deploy preview, auto-revert. | ✅ FAIT (vérifié live via stub) |
| D7 | **Graphe de dépendances des tickets** (DAG en colonnes topologiques, flèches vers les dépendances, nœuds colorés par état, depuis `/api/backlog`) — bouton "Deps" | ✅ FAIT (vérifié live) |
| D8 | **Analytics de coût dans le temps** (`/api/analytics` agrège tous les runs ; modale : 4 tuiles + graphes barres SVG dépense/tokens par run + tableau) — clic sur la carte usage | ✅ FAIT (vérifié live) |
| D10 | **Modèle par ticket** (`model:` dans le YAML → override du modèle global ; badge sur la carte) | ✅ FAIT (unit-testé) |
| D9a | **Palette de commandes Cmd-K** (`CommandPalette` : Cmd/Ctrl+K ou bouton ⌘K → recherche fuzzy sur toutes les actions/nav/toggles/switch-projet, ↑↓/↵/esc, groupes) | ✅ FAIT (vérifié live) |
| D9b | **Notifications externes (Slack/Discord/webhook)** (`notify.webhook` YAML + `NotifyConfig` + module `notify.py` urllib zéro-dép ; dispatcher ping sur BLOCKED + résumé run_end ; envoie `text`+`content` pour couvrir Slack ET Discord ; champ Settings « Notify webhook ») | ✅ FAIT (e2e + unit + Settings vérifié live) |
| D9c | Sandbox renforcé des commandes verify via sandboxmcp | différé — mauvais fit tel quel (voir note) |
| D11 | **Mode d'exécution Subscription / API + coût conscient du mode** (toggle Settings qui contrôle le PASSAGE de `ANTHROPIC_API_KEY` au subprocess — jamais sa valeur ; badge topbar ∞/🔑 ; panneau usage relabellisé « API-equivalent · not charged » en abonnement vs « billed » en API ; analytics sépare billed/plan-equivalent, jamais additionnés ; RunGuard avertit « real dollars » en API) | ✅ FAIT (4 surfaces vérifiées live ; env pass-through unit+e2e) |
| D12 | **Indicateur d'usage du forfait (abonnement)** — la vraie contrainte en abonnement n'est pas le $, c'est la fenêtre de plan. Le CLI streame un `rate_limit_event` (`rate_limit_info`: status, resetsAt epoch, rateLimitType) → capturé dans `stream_headless` → `AgentResult` → event `plan_limit` → panneau usage affiche « ● Plan 5h window · resets in Xh Ym » (pastille verte allowed/rouge sinon, compte à rebours live) en mode abonnement seulement. Pas de « % consommé » (le CLI ne l'expose pas) — honnête. | ✅ FAIT (vérifié live via stub + e2e) |

> **Note D9c (sandbox)** : sandboxmcp isole l'exécution de code Python non fiable. Or dans Agent Factory, ce qui est « non fiable » = les commandes verify/setup/integration (elles exécutent du code écrit par l'agent). Mais ces commandes ont besoin du FS du worktree en rw ET du réseau (npm install, git, uv) — les faire passer par un sandbox durci les casserait plus qu'autre chose. Par ailleurs les agents tournent sous `claude -p` qui a déjà son modèle de permissions (allowed_tools) + les worktrees isolés + le verify gate avant merge = le vrai filet. Le seul angle honnête serait d'exécuter les commandes verify dans un sandbox réseau+FS-scopé (Landlock/Docker) pour que les tests écrits par l'agent ne puissent pas exfiltrer/abîmer l'hôte — vrai chantier, à décider avec Gaël, pas à improviser.

---

## Ordre conseillé
1. **B1 + B2** (mémoire appliquée + répondre au bloqué) — le cœur produit, ce qui rend l'outil unique.
2. **A3 + A4** (modale d'historique riche) — très visible, complète le prototype.
3. **C1 + C2 + C3** (notifs, toasts, clavier/a11y) — gros confort pour peu d'effort.
4. **B3 + B4 + A1** (gestion de projet : budget par projet, éditer/supprimer) — cohérence du portail.
5. Le reste (C4 onboarding, B5 diff par ticket, B7 estimation coût) selon le temps.
