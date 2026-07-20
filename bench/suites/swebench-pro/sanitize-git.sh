#!/bin/bash
# Rebuild a task repository's Git metadata from the exact BASE_SHA closure.
# Detailed identifiers stay in the caller-provided private audit directory;
# safe.txt is the only artifact suitable for publication after the task ends.
set -euo pipefail

umask 077
REPO_DIR=${1:?repository directory is required}
BASE_SHA=${2:?base object ID is required}
AUDIT_DIR=${3:?private audit directory is required}

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE GIT_REPLACE_REF_BASE
unset GIT_NAMESPACE GIT_SHALLOW_FILE GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
export GIT_NO_REPLACE_OBJECTS=1
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export LC_ALL=C

fail() {
  printf 'sanitizer failure: %s\n' "$1" >> "$AUDIT_DIR/private.log"
  exit 1
}

[ -d "$REPO_DIR" ] && [ ! -L "$REPO_DIR" ] || exit 1
[ -d "$AUDIT_DIR" ] && [ ! -L "$AUDIT_DIR" ] || exit 1
chmod 700 "$AUDIT_DIR"
: > "$AUDIT_DIR/private.log"

EXPECTED_GIT_DIR=$REPO_DIR/.git
[ -d "$EXPECTED_GIT_DIR" ] && [ ! -L "$EXPECTED_GIT_DIR" ] \
  || fail 'repository does not have a standalone .git directory'
ACTUAL_GIT_DIR=$(git -C "$REPO_DIR" rev-parse --absolute-git-dir 2>> "$AUDIT_DIR/private.log") \
  || fail 'cannot resolve repository metadata'
[ "$ACTUAL_GIT_DIR" = "$EXPECTED_GIT_DIR" ] \
  || fail 'repository uses nonstandard Git metadata'
[ "$(git -C "$REPO_DIR" rev-parse --is-inside-work-tree 2>> "$AUDIT_DIR/private.log")" = true ] \
  || fail 'repository is not a work tree'

RESOLVED_BASE=$(git -C "$REPO_DIR" rev-parse --verify "$BASE_SHA^{commit}" 2>> "$AUDIT_DIR/private.log") \
  || fail 'base commit is unavailable'
[ "$RESOLVED_BASE" = "$BASE_SHA" ] || fail 'base does not resolve to the expected commit'

# Record every ref and pseudoref privately. The public summary exposes only
# counts, while the object audit below covers ref tips, packed unreachable
# objects, and objects supplied by alternates without retaining their names.
git -C "$REPO_DIR" for-each-ref --format='%(refname) %(objectname)' \
  > "$AUDIT_DIR/refs.before" 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot audit refs'
NON_BASE_REF_COUNT=$(awk -v base="$BASE_SHA" '
  $1 != "refs/heads/base" || $2 != base { count += 1 }
  END { print count + 0 }
' "$AUDIT_DIR/refs.before")

: > "$AUDIT_DIR/pseudorefs.before"
for candidate in "$EXPECTED_GIT_DIR"/*; do
  [ -f "$candidate" ] || continue
  name=${candidate##*/}
  case "$name" in
    HEAD|config|description|index|packed-refs|shallow|commondir|gitdir) continue ;;
    *[!A-Z0-9_-]*) continue ;;
  esac
  oid=$(git -C "$REPO_DIR" rev-parse -q --verify "$name^{object}" 2>> "$AUDIT_DIR/private.log") \
    || continue
  printf '%s %s\n' "$name" "$oid" >> "$AUDIT_DIR/pseudorefs.before"
done
PSEUDOREF_COUNT=$(wc -l < "$AUDIT_DIR/pseudorefs.before" | tr -d '[:space:]')

git -C "$REPO_DIR" rev-list --objects "$BASE_SHA" 2>> "$AUDIT_DIR/private.log" \
  | awk '{ print $1 }' | sort -u > "$AUDIT_DIR/base.objects" \
  || fail 'cannot enumerate the base closure'
git -C "$REPO_DIR" cat-file --batch-all-objects --batch-check='%(objectname)' \
  2>> "$AUDIT_DIR/private.log" | sort -u > "$AUDIT_DIR/original.objects" \
  || fail 'cannot enumerate the original object database'
comm -23 "$AUDIT_DIR/original.objects" "$AUDIT_DIR/base.objects" \
  > "$AUDIT_DIR/audited.objects"

BASE_OBJECT_COUNT=$(wc -l < "$AUDIT_DIR/base.objects" | tr -d '[:space:]')
AUDITED_OBJECT_COUNT=$(wc -l < "$AUDIT_DIR/audited.objects" | tr -d '[:space:]')
[ "$BASE_OBJECT_COUNT" -gt 0 ] || fail 'base closure is empty'

STAGE_DIR=$(mktemp -d "$REPO_DIR/.git-sanitize.XXXXXX") \
  || fail 'cannot create fresh metadata staging directory'
EMPTY_TEMPLATE=$AUDIT_DIR/empty-template
mkdir "$EMPTY_TEMPLATE" || fail 'cannot create an empty Git template'
OLD_GIT=$REPO_DIR/.git-sanitize-old.$$
[ ! -e "$OLD_GIT" ] || fail 'metadata retirement path already exists'
INSTALLED=0
cleanup() {
  if [ "$INSTALLED" -eq 0 ] && [ -d "$OLD_GIT" ] && [ ! -e "$EXPECTED_GIT_DIR" ]; then
    mv "$OLD_GIT" "$EXPECTED_GIT_DIR" 2>/dev/null || true
  fi
  case "$STAGE_DIR" in
    "$REPO_DIR"/.git-sanitize.*) rm -rf "$STAGE_DIR" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

if [ "${#BASE_SHA}" -eq 64 ]; then
  git init --quiet --template="$EMPTY_TEMPLATE" --object-format=sha256 "$STAGE_DIR" \
    2>> "$AUDIT_DIR/private.log" \
    || fail 'cannot initialize fresh SHA-256 metadata'
else
  [ "${#BASE_SHA}" -eq 40 ] || fail 'unsupported object ID format'
  git init --quiet --template="$EMPTY_TEMPLATE" "$STAGE_DIR" 2>> "$AUDIT_DIR/private.log" \
    || fail 'cannot initialize fresh metadata'
fi
FRESH_GIT=$STAGE_DIR/.git
git -C "$STAGE_DIR" symbolic-ref HEAD refs/heads/base 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot initialize base HEAD'
git -C "$STAGE_DIR" config core.logAllRefUpdates false 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot disable fresh reflogs'

printf '%s\n' "$BASE_SHA" \
  | git -C "$REPO_DIR" pack-objects --revs --no-reuse-delta "$FRESH_GIT/objects/pack/pack" \
    > "$AUDIT_DIR/fresh-pack.id" 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot copy the base closure into a fresh object database'
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" update-ref refs/heads/base "$BASE_SHA" \
  2>> "$AUDIT_DIR/private.log" || fail 'cannot create the base branch'
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" read-tree "$BASE_SHA" \
  2>> "$AUDIT_DIR/private.log" || fail 'cannot create the base index'
rm -rf "$FRESH_GIT/logs"

# Validate the staged database without falling back to the original database.
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" fsck --full --no-reflogs --unreachable --no-progress \
  > "$AUDIT_DIR/fsck.staged" 2>&1 || fail 'fresh object database failed fsck'
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" cat-file \
  --batch-all-objects --batch-check='%(objectname)' \
  | sort -u > "$AUDIT_DIR/fresh.objects" \
  || fail 'cannot enumerate fresh objects'
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" rev-list --objects "$BASE_SHA" \
  | awk '{ print $1 }' | sort -u > "$AUDIT_DIR/fresh.reachable" \
  || fail 'cannot enumerate fresh reachable objects'
cmp -s "$AUDIT_DIR/fresh.objects" "$AUDIT_DIR/fresh.reachable" \
  || fail 'fresh object database contains unreachable objects'
cmp -s "$AUDIT_DIR/base.objects" "$AUDIT_DIR/fresh.reachable" \
  || fail 'fresh object database does not match the base closure'
comm -12 "$AUDIT_DIR/audited.objects" "$AUDIT_DIR/fresh.objects" \
  > "$AUDIT_DIR/audited.remaining"
[ ! -s "$AUDIT_DIR/audited.remaining" ] || fail 'an audited object remains'
git --git-dir="$FRESH_GIT" --work-tree="$REPO_DIR" diff \
  --quiet --no-ext-diff "$BASE_SHA" -- 2>> "$AUDIT_DIR/private.log" \
  || fail 'tracked work tree does not match the base'

mv "$EXPECTED_GIT_DIR" "$OLD_GIT" 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot retire original metadata'
mv "$FRESH_GIT" "$EXPECTED_GIT_DIR" 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot install fresh metadata'
INSTALLED=1
rmdir "$STAGE_DIR" 2>> "$AUDIT_DIR/private.log" \
  || fail 'metadata staging directory is not empty'
rm -rf "$OLD_GIT"
[ ! -e "$OLD_GIT" ] || fail 'original metadata was not removed'

# Re-prove the externally visible repository contract after the swap.
git -C "$REPO_DIR" for-each-ref --format='%(refname) %(objectname)' \
  > "$AUDIT_DIR/refs.after" 2>> "$AUDIT_DIR/private.log" \
  || fail 'cannot verify sanitized refs'
[ "$(wc -l < "$AUDIT_DIR/refs.after" | tr -d '[:space:]')" -eq 1 ] \
  || fail 'sanitized repository contains extra refs'
[ "$(cat "$AUDIT_DIR/refs.after")" = "refs/heads/base $BASE_SHA" ] \
  || fail 'sanitized repository does not contain the exact base ref'
[ "$(git -C "$REPO_DIR" symbolic-ref -q HEAD 2>> "$AUDIT_DIR/private.log")" = refs/heads/base ] \
  || fail 'sanitized HEAD is not the base branch'
[ "$(git -C "$REPO_DIR" rev-parse HEAD 2>> "$AUDIT_DIR/private.log")" = "$BASE_SHA" ] \
  || fail 'sanitized HEAD moved away from base'
[ ! -e "$EXPECTED_GIT_DIR/objects/info/alternates" ] \
  || fail 'sanitized repository retained alternates'
[ ! -e "$EXPECTED_GIT_DIR/logs" ] || fail 'sanitized repository retained reflogs'
[ ! -e "$EXPECTED_GIT_DIR/packed-refs" ] || fail 'sanitized repository retained packed refs'
SANITIZED_STATUS=$(git -C "$REPO_DIR" status --porcelain --untracked-files=no \
  2>> "$AUDIT_DIR/private.log") || fail 'cannot verify the sanitized work tree'
[ -z "$SANITIZED_STATUS" ] || fail 'sanitized tracked work tree does not match the base'

cat > "$AUDIT_DIR/safe.txt" <<EOF
schemaVersion=1
status=sanitized
nonBaseRefsRemoved=$NON_BASE_REF_COUNT
pseudorefsRemoved=$PSEUDOREF_COUNT
baseReachableObjects=$BASE_OBJECT_COUNT
auditedObjectsRemoved=$AUDITED_OBJECT_COUNT
onlyBaseRef=true
auditedObjectsAbsent=true
unreachableObjectsAbsent=true
alternatesAbsent=true
reflogsAbsent=true
trackedWorktreeMatchesBase=true
EOF
chmod 600 "$AUDIT_DIR/safe.txt"
trap - EXIT HUP INT TERM
