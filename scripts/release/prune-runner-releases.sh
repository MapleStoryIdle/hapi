#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:?Usage: prune-runner-releases.sh <runner-root> [keep-count]}"
KEEP="${2:-3}"

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || {
    echo "Keep count must be a positive integer" >&2
    exit 2
}

shopt -s nullglob
candidates=()
for path in "$ROOT"/*; do
    release="${path##*/}"
    if [[ -d "$path" && "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        candidates+=("$path")
    fi
done

releases=()
if (( ${#candidates[@]} > 0 )); then
    while IFS= read -r path; do
        releases+=("${path##*/}")
    done < <(ls -1dt "${candidates[@]}")
fi

for ((index = KEEP; index < ${#releases[@]}; index++)); do
    release="${releases[$index]}"
    rm -rf -- "$ROOT/$release"
    echo "Removed old Runner release: $release"
done
