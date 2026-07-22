#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): typecheck the workspace package that owns the
# file that was just edited. Mirrors AGENTS.md §8 — "verification is
# command-evidence based" — by catching type errors immediately after an edit,
# not just at the next full `pnpm typecheck` run.
#
# Deliberately narrow in scope: only *.ts/*.tsx files under a known workspace
# package trigger a check, and only that package's typecheck runs (not the
# whole monorepo) to keep this fast enough to run on every edit.
set -euo pipefail

input="$(cat)"
file_path="$(echo "$input" | jq -r '.tool_input.file_path // empty')"

# Nothing to do if there's no file path, or it's not TypeScript.
if [[ -z "$file_path" ]]; then
  exit 0
fi
if [[ "$file_path" != *.ts && "$file_path" != *.tsx ]]; then
  exit 0
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Normalize to a path relative to the project root so prefix matching works
# regardless of whether the tool reported an absolute or relative path.
rel_path="$file_path"
if [[ "$file_path" == "$project_dir"/* ]]; then
  rel_path="${file_path#"$project_dir"/}"
fi

# Map the edited file to its owning workspace package directory.
pkg_dir=""
case "$rel_path" in
  apps/api/*) pkg_dir="apps/api" ;;
  apps/worker/*) pkg_dir="apps/worker" ;;
  apps/web/*) pkg_dir="apps/web" ;;
  packages/shared/*) pkg_dir="packages/shared" ;;
  packages/tooling/*) pkg_dir="packages/tooling" ;;
  *) exit 0 ;; # edited file isn't inside a known workspace package (e.g. root config) — skip
esac

pkg_json="$project_dir/$pkg_dir/package.json"
if [[ ! -f "$pkg_json" ]]; then
  exit 0
fi

pkg_name="$(jq -r '.name // empty' "$pkg_json")"
if [[ -z "$pkg_name" ]]; then
  exit 0
fi

# Run only that package's typecheck script, from the project root, via pnpm's
# workspace filter — cheaper than a full monorepo typecheck on every edit.
if ! output="$(cd "$project_dir" && pnpm --filter "$pkg_name" run typecheck 2>&1)"; then
  echo "Typecheck failed for $pkg_name after editing $rel_path:" >&2
  echo "$output" >&2
  exit 2
fi

exit 0
