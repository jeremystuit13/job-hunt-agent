---
name: jobs-handshake
description: Attended sweep of the user's SDSU Handshake (on-campus jobs and internships) through their logged-in Chrome, ingested into the same corpus. Requires Claude in Chrome tools and the user present. Use when asked to refresh Handshake.
---

# jobs-handshake

**Attended only** — needs the user's logged-in Chrome and the browser tools enabled (`/chrome`). If browser tools aren't available in the session, stop and say so; do not attempt workarounds. Load the `claude-in-chrome` skill first.

## Procedure
1. Open `https://sdsu.joinhandshake.com/stu/jobs` (school subdomain may differ — use whatever the user is logged into). Confirm logged in; if a login/SSO wall appears, stop and ask the user — never enter credentials.
2. Apply filters: **Part-time** (and separately **Internship**) job types; location San Diego / on-campus. Page through results reading title, employer, location, job type, pay if shown, deadline, posted date, and the posting URL.
3. Write rows to a temp JSON array and ingest:
   `cat rows.json | node scripts/ingest.mjs handshake --track parttime` (and `--track internship` for the internship pass). Set `deadline` whenever Handshake shows one — it feeds the urgency score.
4. Run the jobs-sweep pipeline steps 2–7 (score → pull → push → write).

## Selectors / page structure
Record what actually worked here after the first real run (page structure changes; this section is the one thing that will need repair):
- _not yet discovered — fill in on first attended run_

## Limits
- Read-only browsing. Don't click Apply, Save, or message employers.
- Go at a human pace; don't hammer pagination. ~1 pass/week is enough.
