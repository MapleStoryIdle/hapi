#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${1:?Usage: publish-runner-downloads.sh <ssh-host> [repo-root] [version]}"
REPO_ROOT="${2:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
VERSION="${3:-$(bun -e "console.log(require('$REPO_ROOT/cli/runner-version.json').version)")}"
REPOSITORY="${SHAPI_GITHUB_REPOSITORY:-MapleStoryIdle/hapi}"
KEEP_RELEASES="${SHAPI_KEEP_RUNNER_RELEASES:-3}"
TAG="runner-v${VERSION}"
RELEASE_TARGET="${SHAPI_RUNNER_RELEASE_TARGET:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
DOWNLOAD_BASE_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}"
LOCAL_OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/shapi-runner-release.XXXXXX")"
REMOTE_STAGE="/opt/hapi/downloads/.staging-${VERSION}-$$"
REMOTE_ROOT="/opt/hapi/downloads"
trap 'rm -rf "$LOCAL_OUTPUT"' EXIT

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Version must be a stable semantic version: $VERSION" >&2
    exit 2
}
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "Invalid GitHub repository: $REPOSITORY" >&2
    exit 2
}
[[ "$KEEP_RELEASES" =~ ^[1-9][0-9]*$ ]] || {
    echo "SHAPI_KEEP_RUNNER_RELEASES must be a positive integer" >&2
    exit 2
}
command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 1; }
gh auth status >/dev/null

bun "$REPO_ROOT/scripts/release/prepare-runner-downloads.ts" \
    --version "$VERSION" \
    --download-base-url "$DOWNLOAD_BASE_URL" \
    --binaries-dir "$REPO_ROOT/cli/dist-runner-exe" \
    --output-dir "$LOCAL_OUTPUT"

RELEASE_DIR="$LOCAL_OUTPUT/runner/$VERSION"
(
    cd "$RELEASE_DIR"
    shasum -a 256 -c checksums.txt
)

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
    echo "Reusing existing GitHub Runner release $TAG"
else
    gh release create "$TAG" "$RELEASE_DIR"/* \
        --repo "$REPOSITORY" \
        --target "$RELEASE_TARGET" \
        --title "SHAPI Runner $VERSION" \
        --notes "Runner-only binaries for SHAPI $VERSION. Install or update with: curl -fsSL https://hapi.ye2moe.fun/install.sh | sh"
fi

for release_asset in "$RELEASE_DIR"/*; do
    asset_name="${release_asset##*/}"
    asset_size="$(wc -c < "$release_asset" | tr -d '[:space:]')"
    asset_digest="$(shasum -a 256 "$release_asset" | awk '{ print $1 }')"
    printf '%s\t%s\tsha256:%s\n' "$asset_name" "$asset_size" "$asset_digest"
done | sort > "$LOCAL_OUTPUT/expected-assets.txt"
gh api "repos/$REPOSITORY/releases/tags/$TAG" \
    --jq '.assets[] | [.name, (.size | tostring), .digest] | @tsv' \
    | sort > "$LOCAL_OUTPUT/github-assets.txt"
cmp "$LOCAL_OUTPUT/expected-assets.txt" "$LOCAL_OUTPUT/github-assets.txt"

ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST" "mkdir -p '$REMOTE_STAGE'"
scp "$LOCAL_OUTPUT/install.sh" "$SSH_HOST:$REMOTE_STAGE/install.sh"
scp "$LOCAL_OUTPUT/runner/latest.json" "$SSH_HOST:$REMOTE_STAGE/latest.json"

ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST" \
    "REMOTE_STAGE='$REMOTE_STAGE' REMOTE_ROOT='$REMOTE_ROOT' bash -s" <<'REMOTE'
set -euo pipefail
trap 'rm -rf "$REMOTE_STAGE"' EXIT
mkdir -p "$REMOTE_ROOT/runner"
chmod 755 "$REMOTE_ROOT" "$REMOTE_ROOT/runner"
install -m 755 "$REMOTE_STAGE/install.sh" "$REMOTE_ROOT/.install.sh.next"
mv -f "$REMOTE_ROOT/.install.sh.next" "$REMOTE_ROOT/install.sh"
install -m 644 "$REMOTE_STAGE/latest.json" "$REMOTE_ROOT/runner/.latest.json.next"
mv -f "$REMOTE_ROOT/runner/.latest.json.next" "$REMOTE_ROOT/runner/latest.json"
find "$REMOTE_ROOT/runner" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -exec rm -rf -- {} +
echo "Published Runner metadata under $REMOTE_ROOT; binaries are hosted by GitHub Releases"
REMOTE

release_index=1
while IFS=$'\t' read -r _published_at old_tag; do
    [[ -n "$old_tag" ]] || continue
    [[ "$old_tag" != "$TAG" ]] || continue
    release_index=$((release_index + 1))
    if (( release_index > KEEP_RELEASES )); then
        gh release delete "$old_tag" --repo "$REPOSITORY" --cleanup-tag --yes
        echo "Removed old GitHub Runner release: $old_tag"
    fi
done < <(
    gh release list --repo "$REPOSITORY" --limit 100 \
        --json tagName,publishedAt \
        --jq '.[] | select(.tagName | test("^runner-v[0-9]+\\.[0-9]+\\.[0-9]+$")) | [.publishedAt, .tagName] | @tsv' \
        | sort -r
)

echo "Published SHAPI Runner $VERSION: $DOWNLOAD_BASE_URL"
