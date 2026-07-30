#!/usr/bin/env bash
# Validates that the schedulepoint-research workspace has all required
# directories and that required files exist and are non-empty.
set -u

cd "$(dirname "$0")"

fail=0

check_dir() {
  if [ ! -d "$1" ]; then
    echo "MISSING DIR : $1"
    fail=1
  else
    echo "OK dir      : $1"
  fi
}

check_file_nonempty() {
  if [ ! -f "$1" ]; then
    echo "MISSING FILE: $1"
    fail=1
  elif [ ! -s "$1" ]; then
    echo "EMPTY FILE  : $1"
    fail=1
  else
    echo "OK file     : $1"
  fi
}

echo "== Directories =="
check_dir "reports"
check_dir "reports/inbox"
check_dir "screenshots/navigation"
check_dir "screenshots/schedule"
check_dir "screenshots/requests"
check_dir "screenshots/vacation"
check_dir "screenshots/picklist"
check_dir "screenshots/admin"
check_dir "screenshots/errors"

echo ""
echo "== Required files =="
check_file_nonempty "reports/manifest.json"
check_file_nonempty "reports/source-page-index.md"
check_file_nonempty "reports/evidence-register.md"
check_file_nonempty "reports/unresolved-questions.md"
check_file_nonempty "MASTER-CHECKLIST.md"

echo ""
echo "== manifest.json JSON validity =="
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import json,sys; json.load(open('reports/manifest.json'))" 2>/dev/null; then
    echo "OK json     : reports/manifest.json parses"
  else
    echo "INVALID JSON: reports/manifest.json"
    fail=1
  fi
else
  echo "SKIP (no python3 available to validate JSON)"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "PASS: all required files and directories are present and non-empty."
  exit 0
else
  echo "FAIL: one or more checks failed (see above)."
  exit 1
fi
