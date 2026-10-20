#!/usr/bin/env bash
# Publish thoughtdag.sixkiller.tech on the sixkiller-server Cloudflare Tunnel, behind
# Cloudflare Access. Idempotent: each step is skipped when its object already exists.
# Order (see github.com/selakavon/hermes CLAUDE.md): Access app, tunnel route, DNS.
#
# Needs two private files, neither in this public repo:
#   ~/.config/cloudflare/sixkiller.env  CF_ACCOUNT, CF_ZONE, CF_TUNNEL, CF_POLICY_OWNER_ONLY, CF_TEAM
#                                        (the values are in the private hermes repo's CLAUDE.md)
#   ~/.config/cloudflare/api-token      scoped token, mode 600, with
#     Account: Access: Apps and Policies (Write), Cloudflare Tunnel (Write); Zone: DNS (Write)
# The token is read from the file and passed to curl on stdin, never on argv.
set -euo pipefail

IDS="${CF_IDS_FILE:-$HOME/.config/cloudflare/sixkiller.env}"
[ -r "$IDS" ] || { echo "no identifiers at $IDS" >&2; exit 2; }
# shellcheck source=/dev/null
. "$IDS"
: "${CF_ACCOUNT:?}" "${CF_ZONE:?}" "${CF_TUNNEL:?}" "${CF_POLICY_OWNER_ONLY:?}" "${CF_TEAM:?}"
ACCT=$CF_ACCOUNT; ZONE=$CF_ZONE; TUNNEL=$CF_TUNNEL; POLICY=$CF_POLICY_OWNER_ONLY; TEAM=$CF_TEAM
HOST=thoughtdag.sixkiller.tech
ORIGIN=http://localhost:9122
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}"
[ -r "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE" >&2; exit 2; }

cf() {  # cf METHOD /api/path [json-body]
  local hdr; hdr="header = \"Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")\""
  if [ -n "${3:-}" ]; then
    printf '%s\n' "$hdr" | curl -sS -K - -X "$1" -H "Content-Type: application/json" --data "$3" "https://api.cloudflare.com/client/v4$2"
  else
    printf '%s\n' "$hdr" | curl -sS -K - -X "$1" "https://api.cloudflare.com/client/v4$2"
  fi
}
ok() { jq -e '.success == true' >/dev/null 2>&1 <<<"$1" || { echo "API error:" >&2; jq '.errors' <<<"$1" >&2; exit 1; }; }

# 1. Access application (self-hosted, owner-only policy, 24 h sessions)
apps=$(cf GET "/accounts/$ACCT/access/apps?per_page=100"); ok "$apps"
app=$(jq -c --arg d "$HOST" '.result[] | select(.domain == $d)' <<<"$apps" || true)
if [ -z "$app" ]; then
  body=$(jq -nc --arg d "$HOST" --arg p "$POLICY" '{name:"ThoughtDAG", type:"self_hosted", domain:$d, session_duration:"24h", policies:[{id:$p, precedence:1}]}')
  r=$(cf POST "/accounts/$ACCT/access/apps" "$body"); ok "$r"
  app=$(jq -c '.result' <<<"$r"); echo "created Access app"
else echo "Access app exists"; fi
APP_ID=$(jq -r '.id' <<<"$app"); AUD=$(jq -r '.aud' <<<"$app")
echo "app $APP_ID aud $AUD"

# 2. Tunnel ingress, inserted before the catch-all rule, with the AUD required
cfg=$(cf GET "/accounts/$ACCT/cfd_tunnel/$TUNNEL/configurations"); ok "$cfg"
if jq -e --arg h "$HOST" '.result.config.ingress[] | select(.hostname == $h)' <<<"$cfg" >/dev/null; then
  echo "tunnel route exists"
else
  newcfg=$(jq -c --arg h "$HOST" --arg s "$ORIGIN" --arg t "$TEAM" --arg a "$AUD" '
    .result.config
    | .ingress = (.ingress[:-1] + [{hostname:$h, service:$s, originRequest:{access:{required:true, teamName:$t, audTag:[$a]}}}] + .ingress[-1:])
    | {config: .}' <<<"$cfg")
  r=$(cf PUT "/accounts/$ACCT/cfd_tunnel/$TUNNEL/configurations" "$newcfg"); ok "$r"
  echo "added tunnel route $HOST -> $ORIGIN"
fi

# 3. Proxied CNAME to the tunnel
recs=$(cf GET "/zones/$ZONE/dns_records?name=$HOST"); ok "$recs"
if jq -e '.result | length > 0' <<<"$recs" >/dev/null; then
  echo "DNS record exists"
else
  body=$(jq -nc --arg n "${HOST%%.*}" --arg c "$TUNNEL.cfargotunnel.com" '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1}')
  r=$(cf POST "/zones/$ZONE/dns_records" "$body"); ok "$r"; echo "created DNS record"
fi

# 4. From outside, an unauthenticated request must bounce to Access
sleep 5
code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://$HOST/" || true)
echo "unauthenticated GET https://$HOST/ -> $code"
