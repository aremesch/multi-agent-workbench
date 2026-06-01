# Project Naming Proposal

## Context

The project is currently called **Multi-Agent Workbench (MAW)** — a
descriptive working title, not a brand. Before going OSS on GitHub under a
GPL-derived license, we want a real name: distinctive, memorable, unlikely
to collide with an existing trademark or popular GitHub project, and with
at least one workable domain (`.dev`, `.io`, `.sh`, `.run`).

What the product *is*, in one line: a self-hosted web workbench that
orchestrates many LLM coding-agent CLIs in parallel, each in its own tmux
session + git worktree, with phone-first push alerts so you can approve
permission prompts from anywhere.

Naming axes that matter:
- **Orchestration / multiplicity** (many agents, coordination)
- **Isolation / containment** (worktrees, tmux cells)
- **Remote presence / phone-first** (answer from anywhere)
- **Short** (5–8 chars ideal; CLI binary will be `maw` or equivalent)

---

## Candidate Names

Each candidate has: concept, pros, cons, and a **verification checklist**
(to run live before committing).

### Tier 1 — Strongest

#### 1. **Cloister**
- **Concept:** Monastic cells = isolated worktrees; agents labor quietly
  in separate rooms under one roof. Evokes focus, isolation, coordination.
- **Pros:** Evocative, uncommon in dev-tools space, 8 chars, pleasant to
  say. Rich metaphor (cells, scriptorium, bell tower = alerts).
- **Cons:** Slight religious connotation some may find off-putting.
  Possibly a dictionary word penalty on SEO.
- **CLI binary:** `cloister` or `clst`
- **Verify:** `cloister.dev`, `cloister.sh`, `github.com/cloister`,
  USPTO TESS search for "cloister" in class 9/42, npm `cloister`.

#### 2. **Warren**
- **Concept:** Rabbit warren — network of connected burrows; many
  agents tunneling in parallel.
- **Pros:** Short (6 chars), friendly, strong multi-instance metaphor.
  CLI `warren` reads well.
- **Cons:** Common English name (Warren Buffett, common surname); many
  existing repos named "warren"; potentially crowded namespace.
- **Verify:** `warren.dev`, `warren.sh`, `github.com/warren*`,
  RabbitMQ-adjacent trademark concerns (rabbit imagery), npm `warren`.

#### 3. **Paddock**
- **Concept:** Enclosed area where racehorses stage before a race —
  agents held, prepped, released.
- **Pros:** Clear contained-parallelism metaphor, distinctive, not
  heavily used in dev tools, 7 chars.
- **Cons:** Paddock is a known F1/racing brand; UK clothing retailer.
- **Verify:** `paddock.dev`, `paddock.sh`, `paddock.run`,
  `github.com/paddock`, USPTO TESS (motorsport class is different
  from software class 9 but worth a look).

#### 4. **Muster**
- **Concept:** Military roll-call / gathering of forces. Imperative
  verb: "muster your agents".
- **Pros:** Short (6), verb *and* noun, action-oriented, uncommon.
  Pairs naturally with CLI: `muster spawn`, `muster list`.
- **Cons:** Mustering-out sense is slightly negative; HashiCorp-adjacent
  naming aesthetic (not a conflict, just a vibe).
- **Verify:** `muster.dev`, `muster.sh`, `github.com/muster`, npm, TESS.

### Tier 2 — Viable

#### 5. **Cairn**
- Stacked stones marking a trail — persistence, waypoints, handoff
  between agents. Short (5). Risk: common in geology/outdoor brands
  and there is a well-known `cairn` wallet/crypto project. *Verify
  heavily before choosing.*

#### 6. **Rookery**
- A seabird colony — many nesters, loud, organized chaos. Chess rook
  wordplay (agents as rooks moving independently). Longer (7), slightly
  obscure. Likely clean in dev-tools namespace.

#### 7. **Atrium**
- Central open courtyard with rooms off it. Matches the dashboard-as-
  hub model. Risk: very common word; likely taken on `.com`; TESS
  likely crowded.

#### 8. **Conductor**
- Orchestra conductor of agents. Strong metaphor. *Heavily used* —
  Netflix Conductor, Uber Conductor, Confluent Kafka Connect Conductor.
  Probably rule out.

### Tier 3 — Invented / Portmanteau

#### 9. **Agenda** (from "agent" + "ensemble" / Latin *agenda* = things to do)
- Natural double meaning: the list of tasks + the troupe executing them.
  Risk: it's a dictionary word, Apple has an app called "Agenda", and
  MS Teams has "Agenda" features.

#### 10. **Paddocke** / **Warrenly** / invented suffixes
- Invented spellings trade memorability for uniqueness. Generally
  not recommended unless Tier 1/2 all fail verification.

---

## Verification Checklist (to run before committing)

For the finalist, run *all* of these:

1. **GitHub org/user:** `gh api users/<name>`, `gh api orgs/<name>`,
   and search `github.com/search?q=<name>&type=repositories`.
2. **Domains:** check `.dev`, `.sh`, `.io`, `.run`, `.app` via a
   registrar (Namecheap / Porkbun / Cloudflare).
3. **npm + crates.io + PyPI:** binary-name squatting risk.
4. **USPTO TESS** (https://tmsearch.uspto.gov/) — search in Class 9
   (downloadable software) and Class 42 (SaaS). Also EUIPO eSearch
   Plus if EU matters.
5. **Google + DuckDuckGo:** plain search for `<name> software`,
   `<name> CLI`, `<name> developer tool` — look for active products
   in the same space, not just any use.
6. **Social handles:** X / Bluesky / Mastodon — at least one workable
   variant.

## Recommendation

Short list for live verification (in order of my preference):

1. **Cloister** — most distinctive metaphor, best fit for worktree/cell
   isolation. Likely winnable in trademark class 9/42.
2. **Muster** — best CLI ergonomics, imperative verb.
3. **Paddock** — cleanest "staging parallel work" metaphor.

If all three collide, fall back to **Rookery** or an invented
portmanteau.

## Out of Scope (this file)

- Logo / visual identity
- Tagline
- The actual rename (directory, package.json, README, sidebar title,
  `maw` CLI binary name) — tracked separately once a name is chosen.
