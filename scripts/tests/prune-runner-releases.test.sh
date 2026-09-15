#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shapi-prune-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

for version in 1.0.0 1.0.1 1.0.2 1.0.3; do
    mkdir "$TMP_ROOT/$version"
    touch -t "20260914010${version##*.}" "$TMP_ROOT/$version"
done
mkdir "$TMP_ROOT/not-a-release"

bash "$REPO_ROOT/scripts/release/prune-runner-releases.sh" "$TMP_ROOT" 3 >/dev/null

[[ ! -e "$TMP_ROOT/1.0.0" ]]
[[ -d "$TMP_ROOT/1.0.1" ]]
[[ -d "$TMP_ROOT/1.0.2" ]]
[[ -d "$TMP_ROOT/1.0.3" ]]
[[ -d "$TMP_ROOT/not-a-release" ]]

echo "Runner release retention test passed"
