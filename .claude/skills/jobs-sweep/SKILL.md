---
name: jobs-sweep
description: Daily job-hunt pipeline for the user — sweep all sources, score, sync with the board, push the ranked slice. Use when asked to refresh/update the job board or run the daily sweep.
---

# jobs-sweep

Working dir: `~/jobhunt`. Board URL is in `board/artifact.url`. Everything here is idempotent; running it twice is safe.

**Division of labor:** steps 1–2 (sweep + score) also run unattended each morning via `schedule/daily.sh` (launchd, plain Node, logs to `logs/sweep.log`) — if that's installed, the corpus is already fresh and a session only needs steps 3–7 to sync the board. Steps 3–6 need the Artifact tool, which does **not** exist in headless `claude -p`, so they can only run in an interactive session.

## Steps (in order)
1. `node scripts/sweep.mjs` — all enabled sources. Quota guards are built in (SerpApi ≈5/day of 250/month, Adzuna 15/day). **Never raise a budget or bypass the guard to "get more results"** — if a source reports `daily budget spent`, that is correct behavior; report it and move on.
2. `node scripts/score.mjs`
3. **Clear the old snapshot, then pull board state** (protects the user's status changes). `rm -rf data/board-pull` FIRST — `read_db --out_dir` never deletes files from earlier pulls, so a stale snapshot silently becomes a union of old and new (resurrecting deleted docs and old statuses). Then Artifact `read_db`, `db_op: list`, `collection: jobs`, `query: {limit: 1000}`, `out_dir: ~/jobhunt/data/board-pull`, `url` from `board/artifact.url`. **The board holds ~2,000 docs (M13: everything in scope), so the list is paginated — repeat with `query.cursor` = the returned `next_cursor` until none is returned.** Check `ls data/board-pull/jobs | wc -l` matches the board's doc count minus `meta/profile`.
4. `node scripts/pull-status.mjs` — syncs the board's status back into sqlite.
5. `node scripts/push.mjs` — writes `data/board-new.json`, `board-remove.json`, `board-refresh.json` (entries reference per-doc files via `file_path`).
6. Execute the writes with Artifact `write_db`, `db_op: batch`, in order **new → remove → refresh**, ≤ 50 ops per batch (concatenate the three JSON arrays and split). Send at most ~3 batches at once — a burst hit `resource-exhausted` (rate-limited) on 2026-11-04; a failed batch is atomic (nothing written), and re-running pull → push afterwards lists exactly what's still missing. Daily volume after the first full sync is small (new postings + scores that moved ≥2 points); the first full sync was 1,957 ops / 40 batches.
7. Refresh the board's first-paint snapshot: `node scripts/build-board.mjs` (writes `board/dist/board.html` from `data/board-seed.json`), then publish **that file** with the Artifact tool, passing the board's `url` from `board/artifact.url` so the link never changes. Only needed when `board/board.html` changed or the seed is stale — the live database is what the board actually shows.
8. Append a one-line board-sync summary to `logs/sweep.log` (date, rows per source, quota used, docs written). **No notifications** — the user chose a silent daily sweep.

## Rules that exist because they were learned the hard way
- **Never `set` an existing board doc** — it wipes `status`/`package`. Only push.mjs's `new` list uses `set`; existing docs get score-only `update`.
- Never delete a doc whose board status isn't `new` (push.mjs already enforces this).
- Sources are Adzuna, SerpApi (Google for Jobs = the only route to Indeed/LinkedIn), SimplifyJobs, verified company boards. **Never automate LinkedIn or Indeed directly** (account-ban risk; Google for Jobs returns the same postings).
- Adzuna's pay/contract-type fields are noisy: predicted salaries are ignored, seniority titles are gated, units are normalized by magnitude. Don't "fix" a bad ranking by hand-editing scores; fix the rule in `scripts/score.mjs` and say why.
- If a source errors, keep going with the others and say which failed.

## Board-owned fields (never write these from a push)
`status`, `package`, `tailor_gaps`, `applied_at`, `followup_at`, `tailor_requested_at`, `status_updated`, `prefill_requested_at`, `prefilled_at`. Also the `meta/profile` doc (written only via `scripts/profile-doc.mjs` → `write_db set`). pull-status never lets a board `new` un-gate a locally `gated` job. push.mjs only ever `set`s brand-new docs and `update`s score/derived fields (`score, subscores, rationale, gap, category, location, role_group, region, url, miles, hourly, closed, pay_*`).
