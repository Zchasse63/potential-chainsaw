#!/usr/bin/env bash
# CLAUDE.md invariant #4, by machine: EXACTLY ONE scheduler — the Netlify tick
# (netlify/functions/scheduler-tick.mts) + the Postgres `jobs` queue. Never a
# second cron/schedule anywhere. This guard fails CI if that's ever violated.
#
# Mirrors the member-bundle Supabase grep: a cheap, boring, load-bearing check.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# (1) Exactly ONE scheduled Netlify function — i.e. one `schedule: "…"` config
#     value across netlify/functions. (A `schedule:` value assignment appears in
#     the config export, not in prose, so this doesn't trip on the comments that
#     mention the word "schedule".)
sched_files=$(grep -rlE "schedule:[[:space:]]*[\"']" netlify/functions 2>/dev/null || true)
sched_count=$(printf '%s' "$sched_files" | grep -c . || true)
if [ "$sched_count" -ne 1 ]; then
  echo "::error::invariant #4: expected EXACTLY ONE scheduled Netlify function, found ${sched_count}"
  printf '  %s\n' $sched_files
  fail=1
fi

# (2) No recurring-loop / cron primitives in SHIPPED SERVER code (workers, the
#     Netlify functions, and the API). Match call/import SYNTAX so the doc
#     comments that merely name these primitives don't false-positive. Frontend
#     apps (apps/web, apps/member) are intentionally out of scope — a UI timer
#     is not a scheduler.
if grep -rInE "setInterval[[:space:]]*\(|from[[:space:]]+['\"]node-cron|require\(['\"]node-cron|cron\.schedule[[:space:]]*\(" \
     workers/src netlify/functions apps/api/src 2>/dev/null | grep -v '\.test\.'; then
  echo "::error::invariant #4: a cron/interval primitive appeared in shipped server code (only the Netlify tick may schedule)"
  fail=1
fi

# (3) No pg_cron (or in-DB cron.schedule) in the migrations — the queue is
#     driven by the external tick, never by an in-database scheduler. Match
#     USAGE syntax (create-extension / cron.schedule call), not the bare word,
#     so the migration comments that say "NEVER pg_cron" don't false-positive.
if grep -rInE "create[[:space:]]+extension[^;]*pg_cron|cron\.schedule[[:space:]]*\(" supabase/migrations 2>/dev/null; then
  echo "::error::invariant #4: pg_cron / in-database cron.schedule appeared in a migration"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "single-scheduler check: OK — one Netlify tick, no other cron/interval/pg_cron."
fi
exit "$fail"
