#!/usr/bin/env bash
# Tests for scripts/project-ref.sh, the check deploy-mcp.yml runs on the
# SUPABASE_PROJECT_REF variable. No network. Run by CI.
#
#   scripts/project-ref.test.sh
set -uo pipefail

script="$(dirname "$0")/project-ref.sh"
ref=abcdefghijklmnopqrst
passed=0
failed=0

# expect <label> <ok|fail> <input> [expected output]
expect() {
  local label="$1" want="$2" input="$3" out status
  out=$(bash "$script" "$input" 2>/dev/null)
  status=$?
  if [ "$want" = ok ] && [ $status -eq 0 ] && [ "$out" = "${4-}" ]; then
    passed=$((passed + 1)); echo "  ok    $label"
  elif [ "$want" = fail ] && [ $status -ne 0 ] && [ -z "$out" ]; then
    passed=$((passed + 1)); echo "  ok    $label"
  else
    failed=$((failed + 1)); echo "  FAIL  $label (exit $status, output \"$out\")"
  fi
}

echo "project-ref.sh"
expect 'a clean ref passes unchanged' ok "$ref" "$ref"
expect 'two leading spaces (the first deploy) are trimmed' ok "  $ref" "$ref"
expect 'trailing spaces too' ok "$ref   " "$ref"
expect 'tabs, newlines and a CR from a copy-paste' ok $'\t'"$ref"$'\r\n' "$ref"
expect 'empty fails' fail ''
expect 'whitespace only fails' fail '   '
expect 'uppercase fails' fail ABCDEFGHIJKLMNOPQRST
expect '19 letters fail' fail abcdefghijklmnopqrs
expect '21 letters fail' fail abcdefghijklmnopqrstu
expect 'a space inside fails' fail 'abcdefghij klmnopqrst'
expect 'digits fail' fail abcdefghijklmnopqrs1
expect 'a URL instead of the ref fails' fail "https://$ref.supabase.co"

msg=$(bash "$script" "  ABC" 2>&1 >/dev/null)
if [[ "$msg" == *'must be 20 lowercase letters'*'"ABC" (3 characters after trimming)'* ]]; then
  passed=$((passed + 1)); echo "  ok    the error says what was wrong"
else
  failed=$((failed + 1)); echo "  FAIL  the error says what was wrong: $msg"
fi

echo
echo "  $passed passed, $failed failed"
[ $failed -eq 0 ]
