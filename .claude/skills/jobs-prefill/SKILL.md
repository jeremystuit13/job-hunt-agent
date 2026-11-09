---
name: jobs-prefill
description: Open the user's queued applications in their own Chrome and fill them in from each job's tailored application kit, stopping before Submit so they review and submits himself. Use when asked to "prefill my applications". Requires Claude in Chrome browser tools.
---

# jobs-prefill  (M15 — "auto apply" = land on the application already filled in; the user submits)

Working dir: `~/jobhunt`. Board URL in `board/artifact.url`.

**Requires browser tools (Claude in Chrome).** Load the `chrome-browser` skill first. If its tools aren't available in this session, **stop and say so** — do not fall back to any other automation, and do not mark anything as prefilled. Until browser tools work, the user's interim path is the Simplify Copilot extension on the employer page (see the plan, M15).

## The queue
`rm -rf data/board-pull` → Artifact `read_db` (`list`, `jobs`, `out_dir: data/board-pull`). Queued = docs with `prefill_requested_at` set and no `prefilled_at` after it, **and** a `package` (status `ready`). A queued job without a package → tell the user to Quick-tailor it first; skip it. Also `read_db get meta/profile` for his details.

## Per job
1. Open the job's `url` (the employer's application page) in a **new tab** in his Chrome. If the page needs sign-in or **account creation (Workday, iCIMS, Taleo)**: stop on that job and hand it back — never create accounts, never type or invent passwords.
2. Fill standard fields from `meta/profile` (`fields[].key` → name, email, phone, location, LinkedIn, school, degree, graduation). A field that has a `note` (e.g. email conflict, work authorization unconfirmed) is **left blank** and listed for the user.
3. Attach the tailored résumé (and the cover letter if `package.cover_asset_id` exists): download from the board (`/_blob/<id>`) or use `applications/<id>/resume.pdf` / `cover.pdf`. If the browser tools can't set a file input, leave the upload for the user and say which file to pick.
4. Paste screener answers from `package.answers` where a question clearly matches. Never paste an answer flagged `confirm` or `todo`; leave it blank and list it. Unmatched questions stay blank.
5. **Never answer EEO / demographic / disability / veteran questions**, never tick legal attestations or "I certify" boxes, and **never click Submit / Apply / Send** — or any button that advances to a final review-and-submit step that would send on the next click without him.
6. Leave the tab open. `write_db update jobs/<id>` with `{ "prefilled_at": "<iso>" }` only.

## Report back
Per job: which tab, what was filled, what was left blank and why (notes, `[CONFIRM]`, EEO, uploads), and anything that blocked (sign-in wall, unusual form). Remind them nothing was submitted.

## Hard rules
- The user submits. Filling is allowed; submitting, account creation, and attestations are not.
- Values come only from `meta/profile` and the job's `package` — never invent an answer to an unexpected question.
- One application at a time; human pace. Don't retry a failing form more than once.
