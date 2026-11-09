# Architecture

## Data flow

1. **Sweep** (`scripts/sweep.mjs`): each source adapter normalizes postings into one row shape and upserts into SQLite (`data/jobs.db`, via the built-in `node:sqlite`, so there's no native dependency).
2. **Score** (`scripts/score.mjs`): hard gates set `status = 'gated'` with a reason; everything else gets subscores, a weighted composite, a one-line rationale and a one-line gap.
3. **Push** (`scripts/push.mjs`): diffs the in-scope corpus against a snapshot of the board and writes three op lists (new / refresh / remove), each referencing per-document JSON files.
4. **Board** (`board/board.html`): a single-file app hosted as a Claude Artifact with a shared document database and file storage. It subscribes to the `jobs` collection, so writes appear live.
5. **Pull** (`scripts/pull-status.mjs`): my decisions on the board flow back into SQLite before the next push.
6. **Tailor** (`scripts/render-resume.mjs` + the `jobs-tailor` skill): builds the application kit for starred jobs and uploads it.

## Sources

| Source | Access | Budget (enforced) | Notes |
|---|---|---|---|
| SimplifyJobs `listings.json` | one unauthenticated GET | 24/day | largest source; carries no job descriptions |
| Greenhouse / Ashby / Lever | public board APIs | 200/day | tokens verified before use (`verify-boards.mjs`); full JD text |
| Adzuna | free API key | 15/day (weekly cap 1,000 binds first) | local part-time breadth; pay figures need interpretation |
| SerpApi Google for Jobs | free API key | 5/day (~150/month of 250) | the only route to Indeed / LinkedIn postings |

Call counts persist in SQLite (`api_usage`), so the guard holds across runs and crashes.

## Dedupe

The key is `sha1(normCompany | normTitle | normLocation)`. The normalizers collapse legal suffixes ("Stripe, Inc."), title noise ("SWE Intern (Summer 2027)" becomes "software engineer intern") and location shorthands ("SF" becomes "san francisco ca"). When two sources report the same posting, the richer value wins field by field and both sources are recorded; a later sweep can never null out data. A posting that disappears from its source is marked closed, never deleted.

## Scoring

Internships: `0.30 location + 0.25 odds + 0.20 résumé value + 0.15 fit + 0.10 urgency`.
Part-time: `0.30 pay & hours + 0.30 résumé value + 0.20 odds + 0.20 commute`.

- **Odds**: `0.5 × company selectivity + 0.3 × profile strength + 0.2 × posting recency`. Unknown companies count as "standard" and are never penalized.
- **Fit**: keyword overlap between the job description and résumé bullet tags when a description exists. Otherwise it is category affinity only, and the method used is stored alongside the score so the board can say so.
- **Location**: best region across all of a posting's listed locations (San Diego / Bay Area 1.0, rest of California 0.7, remote US 0.6, rest of US 0.3). Non-US-only postings are gated.

Weights live in `profile.yaml`, not in code.

## Board sync protocol

| Field owner | Fields |
|---|---|
| Pipeline (may overwrite) | score, subscores, rationale, gap, category, location, region, url, miles, hourly, closed, pay |
| Board (never written by a push) | status, package, tailor_gaps, applied_at, followup_at, tailor_requested_at, status_updated, prefill_requested_at, prefilled_at |

- New documents are `set`; existing ones only get `update`s of pipeline-owned fields.
- Refreshes are skipped unless the score moves at least 0.02 or a non-score field changes. This keeps a daily sync to real changes instead of rewriting ~2,000 documents as urgency drifts.
- A document is deleted only when it has left the in-scope slice and its board status is still `new`.
- Writes go in atomic batches of up to 50. A rate-limited batch writes nothing, and re-running pull, then push, lists exactly what is still missing.

## Résumé provenance

Every rendered claim line is registered with its bullet id. Before any file is written, the renderer checks every id against the bullet set in `master.yaml` and throws if one is missing. `trace.json` keeps the mapping, plus, for job-description-matched packages, the tags the job description matched, the rationale and the gaps. Education and skills are rendered as facts from their own sections, not as claims.

## Failure modes handled

- **Network not up at the scheduled 07:30 wake:** `daily.sh` waits up to 60 s for connectivity, then skips without spending quota.
- **Hung headless Chrome:** SIGKILL timeout, a throwaway profile per render, one retry. The PDF is deleted first, so a failure can never leave a stale file looking current.
- **A stale board snapshot resurrecting deleted docs:** the snapshot directory is cleared before every pull, and multi-page reads follow the cursor.
