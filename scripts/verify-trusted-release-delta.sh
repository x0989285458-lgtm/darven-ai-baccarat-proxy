#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 3 ]]; then
  printf 'usage: %s <head-sha> <required-parent-sha> <allowed-path>...\n' "$0" >&2
  exit 64
fi

head_sha="$1"
required_parent="$2"
shift 2

[[ "${head_sha}" =~ ^[a-f0-9]{40}$ ]]
[[ "${required_parent}" =~ ^[a-f0-9]{40}$ ]]
test "$(git rev-parse HEAD)" = "${head_sha}"
test "$(git rev-parse HEAD^)" = "${required_parent}"

actual_file="$(mktemp)"
expected_file="$(mktemp)"
cleanup() {
  rm -f "${actual_file}" "${expected_file}"
}
trap cleanup EXIT

printf '%s\0' "$@" | LC_ALL=C sort -z > "${expected_file}"
git -c diff.renames=false diff --no-renames --name-only -z "${required_parent}" "${head_sha}" \
  | LC_ALL=C sort -z > "${actual_file}"

if ! cmp -s "${actual_file}" "${expected_file}"; then
  printf 'release delta differs from exact allowlist\n' >&2
  exit 65
fi
