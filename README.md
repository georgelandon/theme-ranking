# Game Jam Theme Vote

A small, serverless voting room for your next game jam. Participants compare two themes at a time; PostgreSQL records each vote and updates Elo atomically. Rankings stay private until you reveal them. No accounts, dedicated server, or admin UI.

Built with React, Vite, TypeScript, Tailwind CSS, Supabase, and Vitest. The two pages use hash routes (`#/` and `#/results`) so refreshing a GitHub Pages repository subpath works.

## Start locally

Use Node.js 24 LTS and npm.

```sh
npm ci
cp .env.example .env
# Fill in your Supabase project URL and public key in .env.
npm run dev
```

PowerShell: use `Copy-Item .env.example .env`. Without configuration the app shows a setup message, never simulated votes. Vite must be restarted after changing `.env`.

## Set up Supabase

1. Create a Supabase project.
2. In **SQL Editor**, execute [the migration](supabase/migrations/202611090001_initial.sql). It runs in one transaction and initializes a single settings row. Apply it once to a new project; keep future schema changes in new migrations.
3. Edit [themes.txt](themes.txt), then run `npm run seed`. Execute the generated [supabase/seed.sql](supabase/seed.sql) in SQL Editor.
4. In project API settings, copy the project URL and **publishable** key (or legacy **anon** key) to `.env`:

```dotenv
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_KEY
```

**Never use a service-role / secret key in the frontend or a `VITE_` variable.** Public keys are intentionally included in the browser bundle. Database privileges, not key secrecy, enforce security. No Supabase Auth registration or anonymous sign-in setting is needed.

After setup, open the app and choose a theme. In the Supabase Table Editor, verify that `votes` gained a row and the two items gained comparisons. Public users cannot read these tables directly.

## Deploy to GitHub Pages

1. Push this repository to GitHub with a `main` branch (change the workflow branch filter if needed).
2. Under **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Under **Settings → Secrets and variables → Actions → Variables**, add repository variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` with the same public values used locally.
4. Push to `main` or run **Test and deploy** manually. The workflow installs locked dependencies, runs tests against PostgreSQL 17, builds, uploads `dist`, and deploys Pages. Pull requests run tests/build without deploying. Deployment deliberately fails if public configuration is missing.

The default Vite base is `./`, so assets work at `https://USER.github.io/REPO/` as well as a domain root. For an explicit base, set the optional repository variable `VITE_BASE_PATH=/REPO/` (or `/` for a custom domain). Routes remain hash-based.

Supabase project creation, SQL execution, GitHub repository variables, and enabling Pages require access to your accounts. This repository does not provision external resources automatically.

## Run the competition

Use **Supabase Table Editor → competition_settings → row 1** or SQL Editor. These changes are live; no frontend redeploy is required. The browser refreshes settings every 20 seconds and whenever its window regains focus. Database vote checks apply immediately.

| Phase | `voting_enabled` | `leaderboard_visible` |
| --- | --- | --- |
| Voting open (default) | `true` | `false` |
| Voting closed, reveal pending | `false` | `false` |
| Results revealed | `false` | `true` |

```sql
-- Close voting. In-flight votes finish before this update acquires its lock.
update public.competition_settings set voting_enabled = false where id = 1;
-- Reveal results when ready.
update public.competition_settings set leaderboard_visible = true where id = 1;
```

You can also edit `title` and `description`. `updated_at` updates automatically. Keep the singleton row; deleting it closes access safely but prevents the app from opening until it is restored. The visibility flag controls access independently of voting, so follow the phase table to keep results private while voting is open. Once results have been revealed, hiding them again cannot erase copies participants already saw.

## Import and manage themes

Each nonblank line of `themes.txt` is one name. The generator trims whitespace, removes case-insensitive duplicates, and safely escapes quotes and backslashes. New items start at 1500 Elo; `ON CONFLICT DO NOTHING` preserves existing ratings, counters, IDs, and votes. Imports do not re-enable existing disabled themes.

```sh
npm run seed
# Or use custom input/output files:
node scripts/generate-seed.mjs more-themes.txt supabase/more-themes.sql
```

Paste the generated SQL into Supabase SQL Editor. The database's case-insensitive unique index is the final duplicate guard (its Unicode behavior follows your PostgreSQL collation).

In **Table Editor → items**, add a row with a name, rename a name, edit its optional description, or toggle `active`. Leave rating and counters alone. Disabled themes disappear from new pairings; a vote on a stale pair is rejected. Re-enable a theme by setting `active=true`. All themes, including inactive ones, stay in final rankings so past votes remain auditable. Foreign keys protect themes referenced by votes from deletion; disable them instead.

## Database API and privacy

All tables use RLS with no public policies and explicit revocation of table privileges. Security-definer functions use an empty search path and schema-qualified tables. Only these narrow functions are executable by `anon` and `authenticated`:

| RPC | Input | Output |
| --- | --- | --- |
| `get_settings` | none | title, description, voting/visibility booleans |
| `get_themes` | none | active IDs, names, descriptions |
| `get_pair` | `p_session_id`, optional `p_recent_pairs` | two active IDs/names/descriptions, or `[]` |
| `submit_vote` | `p_item_a_id`, `p_item_b_id`, `p_winner_id`, `p_session_id`, optional `p_request_id` | `{ "success": true }` |
| `get_leaderboard` | none | rankings, total votes, refresh timestamp; permission error while locked |

`recompute_ratings` and the settings trigger function have no public execution grants. Use the SQL Editor as the database administrator for maintenance. The frontend never reads `items`, `votes`, or settings tables directly, and never receives ratings while voting. Calling Supabase outside the UI does not bypass these restrictions.

`submit_vote` serializes each session using a transaction advisory lock, reads settings with `FOR SHARE`, then locks both item rows in UUID order. Closure and replay acquire conflicting settings locks. It validates active/distinct themes and a valid winner, inserts history, applies K=32 Elo, and increments both counters in one transaction. It stores fractional numeric ratings; rounding is display-only. The timestamp is assigned after item locks, preserving replay order for overlapping votes. Independent, disjoint pairs commute. Any exception rolls back the entire call.

Each submission includes a cryptographic request UUID. A retry with the same parameters returns success without inserting another vote; altered reuse is rejected. The UI disables cards synchronously and retries uncertain submissions with the same request ID. Each anonymous session also has a 750ms server-side vote cooldown. Local UUIDs persist in localStorage, with an in-memory fallback when storage is blocked.

Anonymous IDs and cooldowns discourage accidental duplicates; they are **not identity verification or robust bot protection**. A determined person can clear storage, invent IDs, or call the public voting RPC repeatedly. For a higher-stakes event, add verified participation or rate limits in a trusted server-side layer. Request IDs do not stop someone intentionally submitting a different request. No IP addresses are stored by this schema. Votes retain pseudonymous session IDs; decide your event's data-retention period.

## Pair selection and ranking

`get_pair` is the replaceable scheduling module in the migration. It chooses a strategy per request:

- **25% exploration:** random pairs.
- **40% under-tested:** favors pairs with fewer combined comparisons using a randomized comparison-count weight.
- **35% close ratings:** favors small Elo gaps with random jitter.

All strategies prefer pairs absent from the browser's last 50 presented pairs and the session's last 20 stored votes. Browser history includes skips and is held in memory; stored votes persist across visits. When all pairs have been seen, repeats are allowed without a retry loop. There is no elimination, and left/right positions are randomized server-side. Fewer than two active themes, or closed voting, returns `[]`.

Pair enumeration is quadratic in active theme count: appropriate for tens or hundreds of game-jam themes. For thousands, replace it with sampled candidates and indexed counters. Selected opponents can provide indirect statistical clues about ratings over many calls; no raw scores or ranking fields are returned.

Leaderboard ranks use `dense_rank` on full-precision Elo. Exact ties share a rank and all first-place themes are recognized; names then UUIDs determine stable row order. Two ratings rounded to the same display value can still have different ranks. Win percentage is wins/comparisons (zero when untested). The winner banner is withheld when there are no votes.

### Audit or repair Elo

Back up your database first, then run in SQL Editor:

```sql
select public.recompute_ratings();
```

Replay resets all theme ratings/counters and processes the complete vote history by `created_at, id`, including inactive themes. It preserves vote records and visibility settings. **Elo is order-dependent**; deterministic ordering matters. Replay blocks live submissions while running; closing voting first is recommended for an audit. A fresh competition needs a separate database/project or an explicitly planned reset; re-importing themes never resets it.

## Verification and maintenance

```sh
npm test
npm run build
npm run preview
```

`npm run test:browser` also checks desktop and mobile flows in a real browser with mocked RPC responses, including hash routing under `/theme-ranking/`. On Windows it uses installed Edge. In CI it uses Playwright Chromium; for other local platforms remove the channel setting in `playwright.config.ts` and run `npx playwright install chromium`. Browser tests write screenshots to `test-results/`.

Vitest covers Elo arithmetic and replay, invalid/closed votes, safe pair outputs, history exhaustion, case-insensitive names, SQL import safety, explicit privileges/RLS boundaries, idempotent retries, cooldowns, and React voting/results states. Local database tests use PGlite (real PostgreSQL compiled to WASM). The GitHub workflow uses PostgreSQL 17 and additionally exercises 30 simultaneous crossed-pair votes and verifies deterministic replay afterward.

To exercise real concurrency locally, point `TEST_DATABASE_URL` at a **disposable, empty test database** using an administrator connection, then run `npm test`. **The database test suite drops and recreates the public schema. Never use a production connection.** Without this variable the concurrency test is skipped; ordinary database tests run locally in isolated memory.

Manual smoke checks after deploying:

1. Open two browsers, vote from each, and verify central vote/counter updates.
2. Use Tab/Enter to select and skip; check narrow/mobile layout.
3. Open `#/results` while locked and try public RPC/table queries: rankings must remain inaccessible.
4. Disable voting while a browser has a pair loaded: its next submission must fail.
5. Reveal results, check the winner, table, total count, and Refresh Results.

Keep `package-lock.json` committed. The Cedarville logo is bundled locally; no external fonts or third-party tracking scripts are fetched. Theme illustrations are decorative CSS, with actual names/descriptions supplied by Supabase. Errors offer retry controls, requests have a 15-second timeout, cards are native keyboard-accessible buttons, status updates use live regions, and reduced-motion preferences are respected.

The site uses Cedarville University's [official blue and gold palette](https://www.cedarville.edu/offices/creative-services/brand/logo) (`#003a63`, `#fdb813`). The unmodified [official logo](https://www.cedarville.edu/ResourcePackages/culayoutv9/assets/dist/images/cedarville-logo-new-2.png) is stored at `public/cedarville-logo.png`. Fall Mini Game Jam details in `src/App.tsx` follow the supplied Fall 2026 event poster: November 14, 9 AM–5 PM, ENS 241, open to all students. Update this event copy for future jams.

Implementation references: [Supabase database functions and privileges](https://supabase.com/docs/guides/database/functions), [Vite deployment to GitHub Pages](https://vite.dev/guide/static-deploy).
