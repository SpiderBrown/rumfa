#!/usr/bin/env bash
# Copies the shared module into places whose bundlers cannot import from
# outside their own folder (the NestJS API, Supabase Edge Functions). Run after editing shared/.
set -euo pipefail
cd "$(dirname "$0")/.."
{ echo "// GENERATED from shared/src/index.ts by scripts/sync-shared.sh. Do not edit."; cat shared/src/index.ts; } \
  > supabase/functions/_shared/shared.ts
mkdir -p apps/api/src/shared
{ echo "// GENERATED from shared/src/index.ts by scripts/sync-shared.sh. Do not edit."; cat shared/src/index.ts; } \
  > apps/api/src/shared/index.ts
echo "shared module synced"
