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
  echo "缺少状态文件：$STATE_FILE。拒绝 push，避免推送历史残留提交。" >&2
  exit 2
fi

target_branch="$(git config --file "$STATE_FILE" --get merge.targetBranch || true)"
target_commit="$(git config --file "$STATE_FILE" --get merge.targetCommit || true)"
origin_target_before="$(git config --file "$STATE_FILE" --get merge.originTargetBefore || true)"
merge_mode="$(git config --file "$STATE_FILE" --get merge.mode || true)"
if [[ "$merge_mode" != "merge" || -z "$target_branch" || -z "$target_commit" ]]; then
  echo "状态文件无效，拒绝 push。" >&2
  exit 2
fi

if [[ "${target_branch:-}" != "$TARGET_BRANCH" ]]; then
  echo "状态文件目标分支是 ${target_branch:-空}，当前请求 push $TARGET_BRANCH，拒绝。" >&2
  exit 2
fi

if ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
  echo "本地目标分支不存在：$TARGET_BRANCH" >&2
  exit 2
fi

git fetch origin

CURRENT_TARGET_HEAD="$(git rev-parse --short "$TARGET_BRANCH")"
if [[ "$CURRENT_TARGET_HEAD" != "${target_commit:-}" ]]; then
  echo "本地 $TARGET_BRANCH HEAD=$CURRENT_TARGET_HEAD，不等于状态文件记录 ${target_commit:-空}。拒绝 push。" >&2
  exit 3
fi

CURRENT_ORIGIN_HEAD=""
if git show-ref --verify --quiet "refs/remotes/origin/${TARGET_BRANCH}"; then
  CURRENT_ORIGIN_HEAD="$(git rev-parse --short "origin/${TARGET_BRANCH}")"
fi
if [[ "$CURRENT_ORIGIN_HEAD" != "${origin_target_before:-}" ]]; then
  echo "origin/$TARGET_BRANCH 已变化：当前=$CURRENT_ORIGIN_HEAD，合并前=${origin_target_before:-空}。拒绝 push，请重新执行合并流程。" >&2
  exit 3
fi

COUNTS="$(git rev-list --left-right --count "origin/$TARGET_BRANCH...$TARGET_BRANCH")"
BEHIND="$(echo "$COUNTS" | awk '{print $1}')"
AHEAD="$(echo "$COUNTS" | awk '{print $2}')"

if [[ "$BEHIND" != "0" ]]; then
  echo "目标分支 $TARGET_BRANCH 已落后 origin/$TARGET_BRANCH $BEHIND 个提交。" >&2
  echo "停止 push，避免覆盖或制造脏合并。请重新执行合并流程或人工处理。" >&2
  exit 3
fi

if [[ "$AHEAD" == "0" ]]; then
  echo "目标分支 $TARGET_BRANCH 没有待 push 的本地提交。"
  rm -f "$STATE_FILE"
  exit 0
fi

echo "开始 push 目标分支 ${TARGET_BRANCH} 到 origin/${TARGET_BRANCH}，待推送提交数：$AHEAD"
git push origin "$TARGET_BRANCH"
rm -f "$STATE_FILE"
echo "目标分支已 push：origin/${TARGET_BRANCH}"
