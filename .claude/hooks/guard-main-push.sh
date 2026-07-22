#!/usr/bin/env bash
# PreToolUse hook (Bash): block `git push` invocations whose target branch is
# `main`.
#
# AGENTS.md §10 mandates `phase-N/<slice>` branches and PR-based integration;
# a direct push to main bypasses code review and lets un-reviewed work land on
# the branch every gate treats as ground truth. This hook enforces that
# procedurally: push from a branch and open a PR instead.
#
# Deliberately conservative / over-blocking rather than under-blocking: this is
# a safety net, not a build step, so an occasional false-positive block (e.g. a
# command that merely mentions "git push" in passing) is an acceptable cost for
# never letting an actual push-to-main slip through unnoticed.
set -euo pipefail

input="$(cat)"
command="$(echo "$input" | jq -r '.tool_input.command // empty')"

if [[ -z "$command" ]]; then
  exit 0
fi

# Fast pre-filter: nothing to do if "git" and "push" don't both appear.
if [[ "$command" != *"git"* || "$command" != *"push"* ]]; then
  exit 0
fi

# Isolate the `git push ...` invocation up to the next shell operator
# (&&, ||, ;, |) or end of string, so chained commands don't confuse parsing.
push_invocation="$(echo "$command" | grep -oP 'git\s+push[^&|;]*' | head -n1 || true)"
if [[ -z "$push_invocation" ]]; then
  exit 0
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
current_branch="$(git -C "$project_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

# Collect positional (non-flag) arguments after `push`: candidates are
# [remote] [refspec...]. This is a heuristic, not a full git CLI parser — it
# covers the common forms (`git push`, `git push origin`, `git push origin
# main`, `git push origin HEAD:main`, `git push -u origin main`, `git push -f
# origin feature:main`) which is what matters for this guard.
positional=()
# shellcheck disable=SC2206
words=($push_invocation)
for ((i = 2; i < ${#words[@]}; i++)); do # skip "git" "push"
  w="${words[$i]}"
  [[ "$w" == -* ]] && continue
  positional+=("$w")
done

target_branch=""
case "${#positional[@]}" in
  0) target_branch="$current_branch" ;; # bare `git push`
  1) target_branch="$current_branch" ;; # `git push origin` — pushes current branch
  *)
    refspec="${positional[1]}"
    if [[ "$refspec" == *:* ]]; then
      target_branch="${refspec#*:}"
    else
      target_branch="$refspec"
    fi
    ;;
esac

if [[ "$target_branch" == "main" ]]; then
  echo "Blocked: direct push to 'main' is not allowed by AGENTS.md §10." >&2
  echo "Push your work to a 'phase-N/<slice>' branch and open a PR instead, so" >&2
  echo "CI (.github/workflows/ci.yml) runs as a reviewable check before main" >&2
  echo "moves — the only trusted green-verification gate this repo relies on" >&2
  echo "per AGENTS.md §8 (command-evidence, never self-attestation)." >&2
  exit 2
fi

exit 0
