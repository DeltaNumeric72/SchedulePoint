#!/usr/bin/env bash
# REV-B — selected red-case arms, each proven in BOTH directions by the
# repository's own runner, selected with the runner's own additive shard filter.
#
# SP_RED_SHARD="k/65" selects the arms whose index satisfies index % 65 == k.
# With 65 registered arms that is exactly the arm at index k — the runner's own
# machinery, no bespoke harness, so what is measured is what CI measures.
#
# Indices are read from the registry order in scripts/red-cases/run.mjs.
set -u
cd /home/user/SchedulePoint
export SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python

ARMS="${1:-17 18 46 47 57 58 61 64}"

for k in $ARMS; do
  echo ""
  echo "################################################################"
  echo "### REV-B red-case arm index ${k}   $(date -Is)"
  echo "################################################################"
  SP_RED_SHARD="${k}/65" corepack pnpm red-cases 2>&1 | tail -40
  echo "### arm ${k} runner exit: ${PIPESTATUS[0]}"
  echo "### tree after arm ${k}:"
  git status --porcelain -- ':!docs/evidence/EV-REVIEW-B' ':!scripts/red-cases/evidence-output.txt' ':!scripts/check-output.txt' || true
  echo "### (empty above == the runner restored the tree)"
done
echo ""
echo "ALL SELECTED ARMS DONE $(date -Is)"
