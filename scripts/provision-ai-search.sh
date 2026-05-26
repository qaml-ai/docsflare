#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${AI_SEARCH_INSTANCE:-docsflare-docs}"
NAMESPACE="${AI_SEARCH_NAMESPACE:-default}"
SEARCH_DIR="${AI_SEARCH_DOCS_DIR:-.docsflare/search}"
ACCOUNT_ID="${DOCSFLARE_CLOUDFLARE_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}"
API_TOKEN="${DOCSFLARE_CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"

if [[ -z "$ACCOUNT_ID" ]] && command -v cf >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  ACCOUNT_ID="$(cf context show 2>/dev/null | jq -r '.accountId.value // empty')"
fi

if [[ -z "$API_TOKEN" && -f "$HOME/.cf/config.toml" ]]; then
  API_TOKEN="$(awk -F'"' '/^access_token = / {print $2}' "$HOME/.cf/config.toml")"
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Missing Cloudflare account ID. Set DOCSFLARE_CLOUDFLARE_ACCOUNT_ID or configure cf context." >&2
  exit 1
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "Missing Cloudflare API token. Set DOCSFLARE_CLOUDFLARE_API_TOKEN or run cf auth login." >&2
  exit 1
fi

api() {
  local method="$1"
  local path="$2"
  shift 2
  curl -sS -X "$method" "https://api.cloudflare.com/client/v4${path}" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    "$@"
}

api_success() {
  local method="$1"
  local path="$2"
  shift 2
  local response=""
  local code=""

  for attempt in 1 2 3 4 5; do
    response="$(api "$method" "$path" "$@")"
    if jq -e '.success == true' >/dev/null 2>&1 <<<"$response"; then
      echo "$response"
      return 0
    fi

    code="$(jq -r '.errors[0].code // empty' 2>/dev/null <<<"$response" || true)"
    if [[ "$attempt" == "5" || ( -n "$code" && "$code" != "7017" ) ]]; then
      echo "$response"
      return 1
    fi

    sleep $((attempt * 2))
  done
}

INSTANCE_PATH="/accounts/${ACCOUNT_ID}/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE_NAME}"

existing="$(api GET "$INSTANCE_PATH")"
if jq -e '.success == true' >/dev/null <<<"$existing"; then
  echo "AI Search instance ${INSTANCE_NAME} already exists."
else
  echo "Creating AI Search instance ${INSTANCE_NAME} with built-in storage."
  created="$(api_success POST "/accounts/${ACCOUNT_ID}/ai-search/namespaces/${NAMESPACE}/instances" \
    -H "Content-Type: application/json" \
    --data "{\"id\":\"${INSTANCE_NAME}\",\"index_method\":{\"vector\":true,\"keyword\":true},\"fusion_method\":\"rrf\",\"chunk_size\":512,\"chunk_overlap\":30,\"max_num_results\":8,\"cache\":true}")" || {
    echo "$created" | jq .
    exit 1
  }

fi

if [[ ! -d "$SEARCH_DIR" ]]; then
  echo "Search directory ${SEARCH_DIR} does not exist. Run npm run build:search-index first." >&2
  exit 1
fi

if items="$(api_success GET "${INSTANCE_PATH}/items")"; then
  item_ids="$(jq -r '.result[]?.id' <<<"$items")"
  if [[ -n "$item_ids" ]]; then
    while IFS= read -r item_id; do
      [[ -n "$item_id" ]] || continue
      echo "Deleting existing AI Search item ${item_id}"
      if ! deleted="$(api_success DELETE "${INSTANCE_PATH}/items/${item_id}")"; then
        echo "$deleted" | jq .
        exit 1
      fi
    done <<<"$item_ids"
  fi
else
  echo "$items" | jq .
  exit 1
fi

uploaded=0
for file in "$SEARCH_DIR"/*.md; do
  [[ -e "$file" ]] || continue
  echo "Uploading ${file}"
  if ! response="$(api_success POST "${INSTANCE_PATH}/items" -F "file=@${file};type=text/markdown")"; then
    echo "$response" | jq .
    exit 1
  fi
  uploaded=$((uploaded + 1))
done

echo "Uploaded ${uploaded} document(s) to ${INSTANCE_NAME}."
api GET "${INSTANCE_PATH}/stats" | jq .
