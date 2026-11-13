#!/usr/bin/env bash
# Prints a Supabase project ref with surrounding whitespace removed, or fails
# with a clear message when what is left isn't a project ref (20 lowercase
# letters, as the Supabase CLI requires).
#
#   scripts/project-ref.sh "$RAW_VALUE"
#
# deploy-mcp.yml runs it on the SUPABASE_PROJECT_REF repository variable before
# anything else. The first deploy failed on a value stored with two leading
# spaces: the CLI rejected it as "Invalid project ref format" with nothing to
# show why (docs/TROUBLESHOOTING.md). Tested by scripts/project-ref.test.sh.
set -euo pipefail

raw="${1-}"
ref="${raw#"${raw%%[![:space:]]*}"}" # strip leading whitespace
ref="${ref%"${ref##*[![:space:]]}"}" # strip trailing whitespace

if [[ ! "$ref" =~ ^[a-z]{20}$ ]]; then
  if [ -z "$ref" ]; then
    echo "SUPABASE_PROJECT_REF is empty or unset: set the repository variable (Settings → Secrets and variables → Actions → Variables)." >&2
  else
    echo "SUPABASE_PROJECT_REF must be 20 lowercase letters (the project's ref, as in https://<ref>.supabase.co), got \"$ref\" (${#ref} characters after trimming)." >&2
  fi
  exit 1
fi

printf '%s\n' "$ref"
