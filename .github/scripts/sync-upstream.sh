#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must point to the step output file}"
readonly upstream_url="${UPSTREAM_URL:-https://github.com/binaricat/Netcatty.git}"
readonly upstream_ref='refs/remotes/upstream-sync/main'

# Do not change origin or a configured upstream remote. Fetch only upstream main
# into a dedicated tracking ref, leaving the fork's main/history intact.
git fetch --no-tags "$upstream_url" "refs/heads/main:${upstream_ref}"
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

changed=false
if git merge-base --is-ancestor "$upstream_ref" HEAD; then
  printf 'Upstream main is already included; no commit or push needed.\n'
else
  ancestor_status=$?
  if [[ "$ancestor_status" -ne 1 ]]; then
    printf 'Unable to determine upstream ancestry (exit %s).\n' "$ancestor_status" >&2
    exit "$ancestor_status"
  fi

  # Fast-forward when possible; otherwise retain both histories in a normal
  # merge commit. Conflicts and rejected pushes stop here without success output.
  git -c commit.gpgsign=false merge --no-edit "$upstream_ref"
  sha="$(git rev-parse --verify HEAD)"
  git push origin HEAD:refs/heads/main

  # A successful push alone is not evidence that main still has this commit.
  remote_line="$(git ls-remote --exit-code origin refs/heads/main)"
  read -r remote_sha remote_ref <<< "$remote_line"
  if [[ "$remote_sha" != "$sha" || "$remote_ref" != 'refs/heads/main' ]]; then
    printf 'origin/main verification failed: expected %s, observed %s.\n' \
      "$sha" "$remote_line" >&2
    exit 1
  fi
  changed=true
fi

sha="$(git rev-parse --verify HEAD)"
# Publish success only after every required operation (including read-back) passed.
printf 'changed=%s\nsha=%s\n' "$changed" "$sha" >> "$GITHUB_OUTPUT"
