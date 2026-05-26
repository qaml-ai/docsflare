#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${AI_SEARCH_INSTANCE:-docsflare-docs}"
NAMESPACE="${AI_SEARCH_NAMESPACE:-default}"
SEARCH_DIR="${AI_SEARCH_DOCS_DIR:-.docsflare/search}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

if [[ -z "$ACCOUNT_ID" ]] && command -v cf >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  ACCOUNT_ID="$(cf context show 2>/dev/null | jq -r '.accountId.value // empty')"
fi

if [[ -z "$API_TOKEN" && -f "$HOME/.cf/config.toml" ]]; then
  API_TOKEN="$(awk -F'"' '/^access_token = / {print $2}' "$HOME/.cf/config.toml")"
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Missing Cloudflare account ID. Set CLOUDFLARE_ACCOUNT_ID or configure cf context." >&2
  exit 1
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN or run cf auth login." >&2
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

INSTANCE_PATH="/accounts/${ACCOUNT_ID}/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE_NAME}"

existing="$(api GET "$INSTANCE_PATH")"
if jq -e '.success == true' >/dev/null <<<"$existing"; then
  echo "AI Search instance ${INSTANCE_NAME} already exists."
else
  echo "Creating AI Search instance ${INSTANCE_NAME} with built-in storage."
  created="$(api POST "/accounts/${ACCOUNT_ID}/ai-search/namespaces/${NAMESPACE}/instances" \
    -H "Content-Type: application/json" \
    --data "{\"id\":\"${INSTANCE_NAME}\",\"index_method\":{\"vector\":true,\"keyword\":true},\"fusion_method\":\"rrf\",\"chunk_size\":512,\"chunk_overlap\":30,\"max_num_results\":8,\"cache\":true}")"

  if ! jq -e '.success == true' >/dev/null <<<"$created"; then
    echo "$created" | jq .
    exit 1
  fi
fi

if [[ ! -d "$SEARCH_DIR" ]]; then
  echo "Search directory ${SEARCH_DIR} does not exist. Run npm run build:search-index first." >&2
  exit 1
fi

items="$(api GET "${INSTANCE_PATH}/items")"
if jq -e '.success == true' >/dev/null <<<"$items"; then
  item_ids="$(jq -r '.result[]?.id' <<<"$items")"
  if [[ -n "$item_ids" ]]; then
    while IFS= read -r item_id; do
      [[ -n "$item_id" ]] || continue
      echo "Deleting existing AI Search item ${item_id}"
      deleted="$(api DELETE "${INSTANCE_PATH}/items/${item_id}")"
      if ! jq -e '.success == true' >/dev/null <<<"$deleted"; then
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
  response="$(api POST "${INSTANCE_PATH}/items" -F "file=@${file};type=text/markdown")"
  if ! jq -e '.success == true' >/dev/null <<<"$response"; then
    echo "$response" | jq .
    exit 1
  fi
  uploaded=$((uploaded + 1))
done

echo "Uploaded ${uploaded} document(s) to ${INSTANCE_NAME}."
api GET "${INSTANCE_PATH}/stats" | jq .
