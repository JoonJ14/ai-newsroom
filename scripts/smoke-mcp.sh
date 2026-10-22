#!/usr/bin/env bash
# Smoke test for the deployed MCP server: tools/list, check_status and
# get_top_picks over plain HTTP, with no Authorization header (the endpoint
# must stay public). Fails if any call errors, the tool count isn't 8, or
# (when an expected commit is given) check_status reports a different commit.
#
#   scripts/smoke-mcp.sh [URL] [EXPECTED_COMMIT]
#
# URL defaults to the hosted endpoint. Run by .github/workflows/deploy-mcp.yml
# after every deploy, with retries while the new version rolls out; run it by
# hand to see what is live. Needs curl and jq. Reads only.
set -euo pipefail

URL="${1:-https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp}"
EXPECTED="${2:-}"

call() {
  local body="$1" out status
  out=$(curl -sS --max-time 60 -w '\n%{http_code}' -X POST "$URL" -H 'Content-Type: application/json' -d "$body")
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "$status" != "200" ]; then
    echo "HTTP $status from $URL: ${out:0:300}" >&2
    return 1
  fi
  if echo "$out" | jq -e '.error' >/dev/null; then
    echo "JSON-RPC error: $(echo "$out" | jq -c '.error')" >&2
    return 1
  fi
  echo "$out"
}

tools=$(call '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length')
echo "tools/list: $tools tools"
[ "$tools" = "8" ] || { echo "expected 8 tools, got $tools" >&2; exit 1; }

status=$(call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_status"}}')
commit=$(echo "$status" | jq -r '.result.content[0].deployment.commit // "missing"')
echo "check_status: commit $commit, $(echo "$status" | jq -r '.result.content[0] | "\(.totalItems) items, last updated \(.lastUpdated), last 24h judged \(.editor.last24h.judgedShare)"')"
if [ -n "$EXPECTED" ] && [ "$commit" != "$EXPECTED" ]; then
  echo "expected commit $EXPECTED, live is $commit" >&2
  exit 1
fi

picks=$(call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_top_picks"}}')
echo "get_top_picks: $(echo "$picks" | jq -r '.result.content[0] | "mode \(.mode), \(.totalItems) stories: " + ([.sections[] | "\(.label) \(.items | length)"] | join(", "))')"

echo "OK: $URL"
