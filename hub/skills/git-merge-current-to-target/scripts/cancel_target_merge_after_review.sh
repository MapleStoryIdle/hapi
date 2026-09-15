#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="${1:-}"
if [[ -z "$TARGET_BRANCH" ]]; then
  echo "用法: $0 <target-branch>" >&2
  exit 2
fi

if [[ "$TARGET_BRANCH" == -* ]] || ! git check-ref-format --branch "$TARGET_BRANCH" >/dev/null 2>&1; then
  echo "目标分支名称无效：$TARGET_BRANCH" >&2
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "当前目录不是 Git 仓库。" >&2
  exit 2
fi

GIT_DIR="$(git rev-parse --git-dir)"
STATE_FILE="$GIT_DIR/shapi-merge-current-to-target-state"
if [[ ! -f "$STATE_FILE" || -L "$STATE_FILE" ]]; then
  echo "缺少状态文件：$STATE_FILE。拒绝 reset，避免误删本地目标分支提交。" >&2
  exit 2
fi

target_branch="$(git config --file "$STATE_FILE" --get merge.targetBranch || true)"
target_commit="$(git config --file "$STATE_FILE" --get merge.targetCommit || true)"
merge_mode="$(git config --file "$STATE_FILE" --get merge.mode || true)"
if [[ "$merge_mode" != "merge" || -z "$target_branch" || -z "$target_commit" ]]; then
  echo "状态文件无效，拒绝 reset。" >&2
  exit 2
fi
if [[ "${target_branch:-}" != "$TARGET_BRANCH" ]]; then
  echo "状态文件目标分支是 ${target_branch:-空}，当前请求取消 $TARGET_BRANCH，拒绝。" >&2
  exit 2
fi

ORIGINAL_BRANCH="$(git branch --show-current)"

git fetch origin
if ! git show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
  echo "远端目标分支 origin/$TARGET_BRANCH 不存在，拒绝 reset。" >&2
  exit 2
fi

CURRENT_TARGET_HEAD="$(git rev-parse --short "$TARGET_BRANCH")"
if [[ "$CURRENT_TARGET_HEAD" != "${target_commit:-}" ]]; then
  echo "本地 $TARGET_BRANCH HEAD=$CURRENT_TARGET_HEAD，不等于状态文件记录 ${target_commit:-空}。拒绝 reset。" >&2
  exit 3
fi

if [[ -n "$ORIGINAL_BRANCH" && "$ORIGINAL_BRANCH" != "$TARGET_BRANCH" ]]; then
  git switch "$TARGET_BRANCH"
fi

git reset --hard "origin/$TARGET_BRANCH"
rm -f "$STATE_FILE"

if [[ -n "$ORIGINAL_BRANCH" && "$ORIGINAL_BRANCH" != "$TARGET_BRANCH" ]]; then
  git switch "$ORIGINAL_BRANCH"
fi

echo "已取消本地 $TARGET_BRANCH merge，已 reset 到 origin/$TARGET_BRANCH，并切回 ${ORIGINAL_BRANCH:-当前分支}。"
