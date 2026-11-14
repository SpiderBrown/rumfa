#!/usr/bin/env bash
# Runs all migrations + seed + scenario tests against a throwaway local
# Postgres database (no Supabase needed). Usage: supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-rumfa_test}
dropdb --if-exists "$DB" >/dev/null
createdb "$DB"
P="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
$P -f tests/shim.sql
PGV=$(psql -X -Atc "show server_version_num" -d "$DB")
for f in migrations/*.sql; do
  if [ "$PGV" -lt 150000 ]; then
    # Supabase runs Postgres 15+; local PG14 lacks security_invoker views
    sed 's/ with (security_invoker = true)//' "$f" | $P -f -
  else
    $P -f "$f"
  fi
done
$P -f tests/grants.sql
$P -f seed.sql
$P -f tests/scenarios.sql
echo "All database tests passed."
