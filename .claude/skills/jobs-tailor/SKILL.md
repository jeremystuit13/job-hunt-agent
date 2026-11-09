---
name: jobs-tailor
description: Build a ready-to-submit application package (JD-matched résumé PDF, cover letter, drafted screener answers) for jobs the user queued on the board, and publish it straight to the board. Use when asked to tailor/prepare applications or "tailor my starred jobs".
---

# jobs-tailor

Working dir: `~/jobhunt`. Board URL is in `board/artifact.url`.

Status flow on the board: `new` → ★ `shortlisted` (starred) → `tailoring` (the user pressed **Quick tailor** — *queued for you*) → `ready` (package built and uploaded) → `applied` → `interview` → `offer`/`rejected`; `dismissed` is recoverable.

**Build the queue:** jobs with `status: tailoring` are the ones to build — that's what "tailor my starred jobs" means. Starred-but-not-queued (`shortlisted`) only if the user explicitly includes them. Never bulk-tailor the rest of the board. **Skip any job flagged `closed`** (the posting is gone) and say so.

## Steps per job — one continuous pass, no pause for review (decided 2026-11-04)

1. **Find the queue.** `rm -rf data/board-pull`, Artifact `read_db` (`list`, collection `jobs`, `out_dir: data/board-pull`), `node scripts/pull-status.mjs`, then list rows with `status = 'tailoring'`.

2. **Read the real posting.** Use the stored `description` in `data/jobs.db` when it's substantial (board- and Google-for-Jobs-sourced rows usually carry the full JD); otherwise WebFetch the job `url`. Community-feed internships (SimplifyJobs) carry no description — if the URL can't be read either, there is no JD: **skip to step 4 with no `selection.json`** (category fallback) and note that in your summary.

3. **Match the JD to the bullet library and write `applications/<job-id>/selection.json`.** Match the posting's *actual* requirements and preferences against the `tags` and text of bullets in `resume/master.yaml` — not the inferred `category`. Schema:
   ```json
   {
     "experiencePicks": [{ "org": "...", "sub": "...", "dates": "...", "bulletIds": ["sm-2", {"id": "sm-1", "variant": "backend"}] }],
     "projectPicks":    [{ "org": "...", "sub": "...", "dates": "...", "bulletIds": ["kt-1", {"id": "kt-2", "variant": "devops"}] }],
     "variantPreference": "backend" | "data" | null,
     "jd_matched_tags": ["..."],
     "rationale": "which JD line drove which pick",
     "gaps": ["what the JD asks for that the record does not support"],
     "cover_detail": "1–2 sentences tying ONE specific real line from the posting to ONE real fact from master.yaml"
   }
   ```
   - A `bulletIds` entry is a plain id or `{id, variant}`; `variant: "default"` forces the base wording. Per-bullet variants beat the single `variantPreference`.
   - Keep it to **one page**: ~6 bullets across ~3 entries. Lead with what the JD asks for most. Drop the least relevant entry rather than squeezing.
   - Reuse the org/sub/dates strings already used in `scripts/render-resume.mjs` for consistency.
   - See `applications/6115fe0ede19f349/selection.json` (DoorDash) and `applications/ca6831eac161b9bd/selection.json` (BAE) for worked examples — same category, different JDs, different résumés.

   **When no existing variant captures what the JD emphasizes, add one to `master.yaml`** under the existing bullet — same facts, different emphasis or vocabulary, with a comment saying which JD prompted it. Never a new fact, number, technology, framework, or scope. If the JD wants something the record doesn't contain (a framework, SQL, testing, Agile), it goes in `gaps`, never into a variant. Re-run the hyphen-wrap check after editing YAML (a line ending in `data-` folds to "data- collection"):
   `python3 -c "import yaml,re;d=yaml.safe_load(open('resume/master.yaml'));import json;print(re.findall(r'\w- \w',json.dumps(d,default=str)))"` → must print `[]`.

4. **Render.** `node scripts/render-resume.mjs <job-id>` → `applications/<job-id>/{resume.pdf, resume.html, trace.json, cover.md, answers.md, apply.url}`. It prints `selection: JD-matched` or `category fallback`. It **hard-fails** if any bullet id doesn't exist (fabrication guard) and if Chrome fails twice — on either failure, stop for that job and report it; don't upload anything. Confirm one page: `python3 -c "from pdfminer.high_level import extract_pages;print(len(list(extract_pages('applications/<id>/resume.pdf'))))"`. Over one page → trim the selection and re-render.

5. **Publish the application kit and mark ready immediately — no review pause.** (Board URL from `board/artifact.url`.)
   - Artifact `upload_asset` `resume.pdf` → `resume_asset_id`. If `cover.pdf` exists, upload it too → `cover_asset_id` (it only exists when the letter has no `[TODO]`; otherwise `null`).
   - `write_db update jobs/<id>` with **only** these keys (file contents read from `applications/<id>/`):
     ```json
     { "status": "ready",
       "package": { "resume_asset_id": "...", "cover_asset_id": "... or null",
                    "cover_text": "<cover.md verbatim>", "answers": <answers.json array>,
                    "generated_at": "<iso>" },
       "tailor_gaps": [ ...gaps from selection.json, or [] ] }
     ```
   - Write gaps to `tailor_gaps`, **not** `gap` — `push.mjs` refreshes `gap` on every sync and would overwrite yours. `applied_at`, `followup_at`, `tailor_requested_at`, `prefill_requested_at`, `prefilled_at` are owned by the board — never write them here. When replacing a package, `delete_asset` the previous résumé/cover assets.
   - The board's kit reads `package.*` plus the `meta/profile` doc (the user's details). If `resume/master.yaml` identity or `profile.yaml` changed, regenerate it: `node scripts/profile-doc.mjs` → `write_db set meta/profile` with `file_path: data/meta-profile.json`.

6. **Summarize to the user** per job: JD-matched or fallback, the gaps, any `[CONFIRM]` lines in `answers.md`, and anything marked CHECK (e.g. citizenship requirements at defense contractors).

## Hard rules
- **Selection, never invention.** Re-word freely (verbs, emphasis, JD vocabulary); numbers, technologies, scope and dates are immutable. Shadowing-level work stays shadowing-level.
- **No review pause ≠ no honesty.** When there's no real JD text, `cover.md` keeps its visible `[TODO: read the actual posting …]` placeholder. Never fill it with a generic or invented "why I love this company" line. `cover_detail` must quote or paraphrase something actually in the posting.
- **Respect each bullet's `verified` / `note` fields in master.yaml.** They record what the evidence does and doesn't support (e.g. a project that uses JSON files, not a database). Never let a JD's vocabulary pull a claim past its evidence.
- `master.yaml → factual_conflicts_found` are unresolved questions for the user (e.g. conflicting dates or contact details between résumé sources). Don't silently pick; call out which default a package used.
- `answers.md` lines marked **[CONFIRM]** rest on placeholder profile values (work authorization especially). Surface them; never let one go out unconfirmed.
- **The user submits.** Never fill in or submit an application form on their behalf — auto-upload means the package lands on the board, nothing more.
- The LinkedIn connection-finder is **deferred** — don't build or run any version of it here.
