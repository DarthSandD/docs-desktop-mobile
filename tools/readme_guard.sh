#!/usr/bin/env bash
# README guard — blocks a commit that deletes or guts documented sections.
#
# Rationale: an automated job rewrites README.md daily. Instructions alone did
# not prevent it from deleting 84 lines of real documentation (see commit
# 415fd21, repaired in 237862c). This turns "please don't" into "you can't".
#
# Install:  bash tools/readme_guard.sh --install
# Check:    bash tools/readme_guard.sh
# Exit 0 = safe to commit. Exit 1 = blocked.

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

README="README.md"
MAX_SHRINK=8          # allowed line loss (table edits can net a few lines)
MAX_DIFF=60           # allowed changed lines (added+removed)

# Sections that must always exist. These document the project for real people.
# NOTE: the H1 title is checked separately by pattern, so renaming the project
# does NOT trip the guard.
PROTECTED=(
  "## What it is"
  "## Screenshots"
  "## Project status"
  "## Environment snapshot"
  "## The core idea"
  "## Features"
  "## Project layout"
  "## Build"
  "## Test"
  "## Notes and limitations"
  "## Daily maintenance"
)

# --------------------------------------------------------------------------
if [ "${1:-}" = "--install" ]; then
  HOOK=".git/hooks/pre-commit"
  mkdir -p .git/hooks
  cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# Installed by tools/readme_guard.sh — blocks commits that gut README.md
bash tools/readme_guard.sh || {
  echo ""
  echo "COMMIT BLOCKED by the README guard."
  echo "Fix README.md (restore the missing sections), or bypass with:"
  echo "  git commit --no-verify"
  exit 1
}
HOOKEOF
  chmod +x "$HOOK"
  echo "installed pre-commit hook at $HOOK"
  exit 0
fi

fail=0
note() { printf '  %s\n' "$1"; }

[ -f "$README" ] || { echo "GUARD: $README not found"; exit 1; }

echo "README guard:"

# --- 1. every protected section must still be present ----------------------
missing=0
for s in "${PROTECTED[@]}"; do
  if ! grep -qF "$s" "$README"; then
    echo "  MISSING SECTION: $s"
    missing=1
    fail=1
  fi
done
[ "$missing" = 0 ] && note "all ${#PROTECTED[@]} protected sections present"

# --- 1b. an H1 title must exist (any name — renames are allowed) -----------
if grep -qE '^# .+' "$README"; then
  note "H1 title present: $(grep -m1 -E '^# .+' "$README")"
else
  echo "  MISSING H1 TITLE: the README has no '# Name' heading"
  fail=1
fi

# --- 2. line count must not collapse ---------------------------------------
CUR=$(wc -l < "$README" | tr -d ' ')
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  BASE=$(git show HEAD:"$README" 2>/dev/null | wc -l | tr -d ' ')
  if [ -n "$BASE" ] && [ "$BASE" -gt 0 ]; then
    LOSS=$((BASE - CUR))
    if [ "$LOSS" -gt "$MAX_SHRINK" ]; then
      echo "  SHRANK TOO MUCH: $BASE -> $CUR lines (lost $LOSS, limit $MAX_SHRINK)"
      fail=1
    else
      note "line count ok ($BASE -> $CUR)"
    fi
  fi
fi

# --- 3. staged diff must not be a rewrite ----------------------------------
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  NUM=$(git diff --numstat HEAD -- "$README" 2>/dev/null | awk '{print $1+$2}' | head -1)
  NUM=${NUM:-0}
  if [ "$NUM" -gt "$MAX_DIFF" ]; then
    echo "  DIFF TOO LARGE: $NUM changed lines (limit $MAX_DIFF) — this is a rewrite, not a refresh"
    fail=1
  else
    note "diff size ok ($NUM changed lines)"
  fi
fi

if [ "$fail" = 0 ]; then
  echo "README guard: PASS"
else
  echo "README guard: FAIL"
fi
exit $fail
