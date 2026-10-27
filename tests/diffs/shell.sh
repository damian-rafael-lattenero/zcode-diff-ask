#!/usr/bin/env bash
# Helper commands for the diff-ask fixture suite.

set -euo pipefail

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    alpha)
      echo "alpha: listing fixture files"
      ls -1 tests/diffs
      ;;
    bravo)
      echo "bravo: counting lines"
      wc -l tests/diffs/* | tail -1
      ;;
    charlie)
      echo "charlie: cleaning up"
      rm -rf /tmp/diff-ask-fixture
      ;;
    *)
      echo "usage: shell.sh [alpha|bravo|charlie]"
      ;;
  esac
}

main "$@"
