# Agent Factory — Plan produit "cockpit self-service"

> Objectif : faire du dashboard un vrai **outil de développement par agents, orienté client final**,
> où un opérateur (même non-ingénieur) pilote tout **sans jamais ouvrir un terminal ni demander à une IA d'intervenir**.
> Aujourd'hui, trop d'actions nécessitent encore la ligne de commande ou une intervention manuelle de Claude.
> Ce document liste chaque manque observé et le transforme en feuille de route priorisée.

Statut du doc : vivant. Dernière révision 2026-07-12.

---

## 1. North Star (la promesse)

> "J'ouvre le dashboard, je décris ce que je veux, je regarde des agents le construire,
> je comprends ce qui se passe et pourquoi, je corrige ce qui coince en deux clics,
> je vois le résultat, et je maîtrise ce que ça me coûte — **sans terminal, sans intervention externe**."

Trois qualités non négociables :

1. **Self-service total** — toute action de pilotage est dans l'UI. Le terminal n'est jamais requis pour l'usage courant.
2. **Lisibilité** — à tout instant, l'opérateur sait *ce qui se passe*, *pourquoi*, et *ce que ça coûte*.
3. **Contrôle du coût** — aucun run ne peut brûler l'abonnement en silence ; les garde-fous sont visibles et réglables.

---

## 2. Le problème central (pourquoi ce plan existe)

Au fil de la session réelle sur le site World Cup, **chaque friction a nécessité une intervention hors UI** :

| Friction rencontrée | Ce qu'il a fallu faire (hors UI) | Devrait être |
|---|---|---|
| Un agent semblait tourner sans fin | Inspecter les process, lire le journal à la main | Bouton d'arrêt fiable + état honnête |
| Une tâche échouait en boucle (3 essais) | Me demander de baisser les réessais dans le YAML | Réglage "réessais" dans Settings |
| Comprendre *pourquoi* une tâche a échoué | Lire `events.jsonl` à la main | Panneau "pourquoi cet échec" dans l'UI |
| Ajuster un ticket trop dur | Édition manuelle | Édition guidée + assistance IA in-app |
| Régler l'effort de raisonnement | Éditer le YAML | Fait ✅ (dropdown Settings) |
| Voir la session live d'un agent | Rien | Fait ✅ (Watch live) |
| Voir le résultat web | Rien | Fait ✅ (View result) |
| Le serveur redémarré cachait le bouton Stop | — | Détecter dispatcher-vivant vs serveur-tracké |

**Conclusion** : le socle technique est solide (dispatcher, worktrees, review gate, event log),
mais la **couche de pilotage humaine est incomplète**. C'est là qu'on investit maintenant.

---

## 3. Principes directeurs

- **Zéro terminal pour l'usage courant.** Si une action utile passe par le shell, c'est un bug d'UI.
- **Jamais d'intervention IA externe pour piloter.** L'IA aide *dans* l'outil (co-création, explications), pas *à la place* de l'outil.
- **Honnêteté d'état.** L'UI ne montre jamais un bouton qui n'agit pas, ni un état "vivant" pour un process mort.
- **Coût visible et borné.** Chaque tâche montre ce qu'elle consomme ; les garde-fous (réessais, effort, slots) sont réglables sans code.
- **Réversible et sûr.** Actions destructrices en deux temps ; rien d'irréversible sans confirmation claire.
- **Tout-terrain.** Windows/macOS/Linux, aucun chemin en dur, aucune dépendance runtime lourde.

---

## 4. Inventaire des manques → chantiers

### Chantier A — Contrôle du run (fiabilité + coût) — **P0**

Le cœur du problème d'aujourd'hui : arrêter, régler, et ne pas gaspiller l'abonnement.

- **A1. Arrêt qui marche toujours.** Détecter un dispatcher *vivant même si le serveur a été redémarré*
  (le run n'est plus "tracké" mais son process lit toujours `control.jsonl`). Dans ce cas, réafficher
  Pause/Stop/Kill au lieu de "Run again". Signal : présence d'un `control.jsonl` récent + absence de `run_end`
  + heartbeat du dispatcher (voir A5).
  - *Critère* : un run lancé avant un redémarrage serveur reste pilotable (stop réel) depuis l'UI.
- **A2. Réessais réglables** (`max_retries`) par défaut global **+ par ticket**, exposé dans Settings.
  Défaut abaissé à **1** (au lieu de 2) pour ne pas brûler 3 passages sur une tâche qui bloque.
  - *Critère* : changer le nombre de réessais dans Settings, sans éditer de fichier.
- **A3. Plafond de dépense par run.** Optionnel : "arrête le run après N échecs cumulés" ou "après X min".
  - *Critère* : un run ne peut pas boucler indéfiniment ; l'opérateur voit la limite active.
- **A4. Bouton "Tout arrêter maintenant" (hard stop).** Kill immédiat de tous les agents en vol (pas "laisse finir").
  - *Critère* : un clic tue les sous-process agents ; l'UI le confirme.
- **A5. Heartbeat dispatcher.** Le dispatcher écrit un `heartbeat` périodique ; l'UI affiche "vivant / silencieux depuis Xs / mort".
  Tue le fantôme définitivement côté lecture.
  - *Critère* : l'UI distingue toujours run vivant / fini / mort-sans-cleanup.

### Chantier B — Comprendre (observabilité + explicabilité) — **P0/P1**

- **B1. "Pourquoi cet échec ?"** Sur une carte FAILED/BLOCKED : panneau qui montre en clair la cause
  (verify échoué, review rejeté + raisons, setup cassé, timeout, rate-limit), avec le verdict du relecteur cité.
  Aujourd'hui il faut lire `events.jsonl`.
  - *Critère* : la raison d'échec est lisible en un clic, sans terminal.
- **B2. Coût/usage par tâche.** Afficher tokens/temps/tours par agent (et cumul run). Rendre le coût tangible.
  - *Critère* : chaque tâche montre sa consommation ; le run montre le total.
- **B3. Timeline enrichie.** La timeline technique existe ; ajouter filtres (par tâche, par type) et liens vers la session live.
- **B4. Sous-agents lisibles** — Fait ✅ (bloc délégation + résultat). Étendre : profondeur >1 si dispo dans le flux.
- **B5. Session live** — Fait ✅ (Watch live). Étendre : indicateur "l'agent attend / réfléchit / agit".

### Chantier C — Créer & corriger le travail (co-création) — **P1**

- **C1. Édition de ticket assistée.** Dans le panneau ticket : bouton "Améliore ce ticket avec l'IA"
  (rendre les critères exécutables, borner le scope, détecter les exigences irréalistes — ex. "48 équipes réelles"
  sans source fiable). Directement lié à l'échec d'aujourd'hui.
  - *Critère* : transformer un ticket vague/trop dur en ticket réalisable, sans quitter l'UI.
- **C2. Répondre à un agent BLOCKED depuis l'UI.** L'agent pose une question → l'opérateur répond →
  reprise via `--resume` (le `session_id` est déjà capturé). Aujourd'hui : impossible sans relancer.
  - *Critère* : un BLOCKED se débloque par une réponse tapée dans l'UI.
- **C3. Redirection en cours de route.** Via le superviseur : "recadre la tâche 2 pour utiliser des données de démo marquées".
  kill→amend→retry orchestré. Le superviseur existe ; exposer l'action "rediriger" explicitement.
- **C4. Modèles de tickets / presets projet.** "Site vitrine", "lib Python", "recherche de données" → squelettes prêts.

### Chantier D — Le produit autour (client-facing) — **P1/P2**

- **D1. Onboarding zéro.** Premier lancement : détecter/installer prérequis, choisir un dossier, créer un workspace, tout guidé.
- **D2. Réglages produit complets.** Settings couvre déjà internet/projet/reviewer/effort/slots ; ajouter réessais (A2),
  plafonds (A3), modèle par rôle, garde-fous coût — le tout en langage humain avec Advanced (YAML) pour les experts.
- **D3. Résultat & livraison.** View result ✅. Ajouter : "Publier" (GitHub) déjà là ; ajouter export/zip, lien de preview partageable.
- **D4. Multi-projets** ✅. Ajouter : vue d'ensemble multi-workspaces (que se passe-t-il partout ?).
- **D5. Accessibilité & thèmes.** Clair/sombre ✅. Ajouter : responsive, tailles de police, contrastes AA.
- **D6. Empaquetage.** Lanceur `.cmd` ✅. Cible : exécutable/installeur un-clic, ou app desktop, sans Node visible.

### Chantier E — Robustesse & confiance (non-fonctionnel) — **continu**

- **E1. Tests côté serveur dashboard** (aujourd'hui non testé — dette honnête). Endpoints + preview + control.
- **E2. Nettoyage des orphelins** au démarrage du serveur (worktrees, process agents fantômes).
- **E3. Sécurité** : garder shell:false, chemins validés, pas de secrets en clair, actions destructrices confirmées.
- **E4. Tout-terrain vérifié** : CI Windows/macOS/Linux sur les parcours UI critiques.

---

## 5. Feuille de route par phases

### Phase 0 — "Ne plus jamais avoir besoin du terminal pour arrêter/régler" (cette semaine)
- A2 (réessais réglables + défaut à 1) ← **livré en premier, aujourd'hui**
- A1 (stop fiable même après redémarrage serveur) + A5 (heartbeat)
- A4 (hard stop) 
- B1 (pourquoi cet échec)

### Phase 1 — "Comprendre et corriger sans moi"
- B2 (coût/usage par tâche), B3 (timeline filtrée)
- C1 (édition ticket assistée), C2 (répondre aux BLOCKED), C3 (redirection explicite)
- D2 (Settings complet : plafonds, modèle par rôle)

### Phase 2 — "Vrai produit client-facing"
- D1 (onboarding), D3 (livraison/partage), D4 (vue multi-projets), D5 (a11y), D6 (empaquetage)
- E1 (tests serveur), E2 (nettoyage orphelins), E4 (CI multi-OS UI)

---

## 6. Définition de "terminé" (par chantier)

Un chantier est fini quand :
- l'action correspondante est **faisable entièrement dans l'UI**, par un non-ingénieur ;
- l'UI reste **honnête** (aucun bouton mort, aucun état faux) ;
- le **coût** de l'action est visible avant/pendant/après ;
- c'est **testé** (Python pour le moteur, et à terme côté serveur dashboard) et **tout-terrain**.

---

## 7. Décisions ouvertes (à trancher avec Gaël)

1. **Défaut réessais** : 1 (proposé) ou 0 pour les tâches de recherche coûteuses ?
2. **Plafond de dépense** : par nombre d'échecs, par temps, par "budget tokens" estimé — lequel prioriser ?
3. **Empaquetage final** : app desktop (Electron/Tauri) ou installeur CLI + navigateur ? (impacte D6)
4. **Données de recherche** : politique par défaut quand une source fiable manque — refuser, ou produire des données de démo marquées "DEMO" ?

---

## 8. Ce qui est DÉJÀ fait (socle acquis)

Dispatcher asyncio (slots réglables), worktrees isolés, verify gate déterministe, merge queue,
rate-limit pause+backoff, event log append-only, control plane (pause/resume/stop/kill/retry),
`plan` (co-création de tickets), review gate adversarial, superviseur conversationnel, doctor
(test réel des permissions), Settings (internet/projet/reviewer/effort/slots), Watch live (session
par ticket), View result (aperçu web), visibilité sous-agents, repo explorer, multi-workspaces,
lanceur cliquable. **La base est là ; ce plan complète la couche humaine.**
