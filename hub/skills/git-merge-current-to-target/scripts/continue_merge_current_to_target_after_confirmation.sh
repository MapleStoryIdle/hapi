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
ORIGINAL_BRANCH="$(git branch --show-current)"

conflict_file_count() {
  local files="${1:-}"
  if [[ -z "$files" ]]; then
    echo 0
  else
    printf '%s\n' "$files" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' '
  fi
}

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && -n "$ORIGINAL_BRANCH" ]]; then
    if [[ "$(git branch --show-current 2>/dev/null || true)" != "$ORIGINAL_BRANCH" ]]; then
      git switch "$ORIGINAL_BRANCH" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

if [[ -f "$GIT_DIR/MERGE_HEAD" || -d "$GIT_DIR/rebase-merge" || -d "$GIT_DIR/rebase-apply" || -f "$GIT_DIR/CHERRY_PICK_HEAD" ]]; then
  echo "当前仓库存在未完成的 merge/rebase/cherry-pick，请先人工处理。" >&2
  exit 2
fi

if [[ -z "$ORIGINAL_BRANCH" ]]; then
  echo "当前处于 detached HEAD，停止。" >&2
  exit 2
fi
if [[ "$ORIGINAL_BRANCH" == "$TARGET_BRANCH" ]]; then
  echo "当前分支和目标分支相同：${ORIGINAL_BRANCH}，停止。" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "当前分支存在未提交改动，不能走确认继续流程。" >&2
  exit 2
fi

git fetch origin

if git show-ref --verify --quiet "refs/remotes/origin/$ORIGINAL_BRANCH"; then
  BEHIND="$(git rev-list --count "$ORIGINAL_BRANCH..origin/$ORIGINAL_BRANCH")"
  AHEAD="$(git rev-list --count "origin/$ORIGINAL_BRANCH..$ORIGINAL_BRANCH")"
  if [[ "$BEHIND" != "0" || "$AHEAD" != "0" ]]; then
    echo "当前分支 ${ORIGINAL_BRANCH} 与 origin/${ORIGINAL_BRANCH} 不一致，停止。请先人工同步。behind=${BEHIND}, ahead=${AHEAD}" >&2
    exit 2
  fi
else
  echo "远端当前分支 origin/${ORIGINAL_BRANCH} 不存在，停止。" >&2
  exit 2
fi

SOURCE_BRANCH="$ORIGINAL_BRANCH"
SOURCE_COMMIT="$(git rev-parse --short HEAD)"

if ! git show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
  echo "远端目标分支 origin/${TARGET_BRANCH} 不存在，停止。" >&2
  exit 2
fi

if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
  git switch "$TARGET_BRANCH"
else
  git switch -c "$TARGET_BRANCH" "origin/$TARGET_BRANCH"
fi

echo "更新目标分支 origin/${TARGET_BRANCH}，只允许 fast-forward。"
if ! git pull --ff-only origin "$TARGET_BRANCH"; then
  echo "目标分支无法 fast-forward 更新，停止。未执行 merge。" >&2
  exit 2
fi
ORIGIN_TARGET_BEFORE="$(git rev-parse --short "origin/$TARGET_BRANCH")"

echo "开始检测并普通合并：$SOURCE_BRANCH -> $TARGET_BRANCH"
set +e
MERGE_OUTPUT="$(git merge --no-ff "$SOURCE_BRANCH" -m "Merge ${SOURCE_BRANCH} into ${TARGET_BRANCH}" -m "Merged-from: ${SOURCE_BRANCH} (${SOURCE_COMMIT})" 2>&1)"
MERGE_CODE=$?
set -e

if [[ $MERGE_CODE -ne 0 ]]; then
  CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
  CONFLICT_COUNT="$(conflict_file_count "$CONFLICT_FILES")"
  if [[ "$CONFLICT_COUNT" -gt 0 && "$CONFLICT_COUNT" -le 3 ]]; then
    echo "MERGE_CONFLICT_NEEDS_ANALYSIS_BEFORE_ABORT"
    echo "$MERGE_OUTPUT"
    echo "冲突文件数: $CONFLICT_COUNT"
    echo "冲突文件:"
    echo "$CONFLICT_FILES"
    echo "冲突文件数 <= 3，按规则暂未执行 git merge --abort。"
    echo "AI 必须只读分析冲突原因和推荐解决策略，然后立即执行 git merge --abort 或 git reset --merge；不得编辑、add、commit、push。"
    exit 13
  fi
  git merge --abort >/dev/null 2>&1 || git reset --merge >/dev/null 2>&1 || true
  echo "MERGE_CONFLICT"
  echo "$MERGE_OUTPUT"
  echo "冲突文件:"
  if [[ -n "$CONFLICT_FILES" ]]; then
    echo "$CONFLICT_FILES"
  else
    echo "未能读取冲突文件列表，请执行 git status 查看。"
  fi
  echo "已执行 git merge --abort。未编辑冲突文件，未 push 目标分支。"
  exit 3
fi

TARGET_COMMIT="$(git rev-parse --short HEAD)"

rm -f "$STATE_FILE"
git config --file "$STATE_FILE" merge.sourceBranch "$SOURCE_BRANCH"
git config --file "$STATE_FILE" merge.sourceCommit "$SOURCE_COMMIT"
git config --file "$STATE_FILE" merge.targetBranch "$TARGET_BRANCH"
git config --file "$STATE_FILE" merge.targetCommit "$TARGET_COMMIT"
git config --file "$STATE_FILE" merge.originTargetBefore "$ORIGIN_TARGET_BEFORE"
git config --file "$STATE_FILE" merge.mode merge
chmod 600 "$STATE_FILE"

git switch "$ORIGINAL_BRANCH"

cat <<SUMMARY
MERGE_LOCAL_SUCCESS
当前分支: ${SOURCE_BRANCH}
目标分支: ${TARGET_BRANCH}
当前分支提交: $SOURCE_COMMIT
目标分支本地 HEAD: $TARGET_COMMIT
状态文件: $STATE_FILE
已完成操作:
- 用户确认后继续合并
- 当前分支已确认与 origin/${SOURCE_BRANCH} 一致
- 已 fast-forward 更新目标分支本地副本
- 已将 ${SOURCE_BRANCH} 普通 merge 到 ${TARGET_BRANCH} 本地分支
- 已切回 ${ORIGINAL_BRANCH}
未完成操作:
- 未 push 目标分支 origin/${TARGET_BRANCH}
下一步:
- 等用户确认后，再执行 push_target_after_confirmation.sh ${TARGET_BRANCH}
- 如果用户取消发布，执行 cancel_target_merge_after_review.sh ${TARGET_BRANCH}
SUMMARY
