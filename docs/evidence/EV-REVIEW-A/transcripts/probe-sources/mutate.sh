#!/usr/bin/env bash
# REV-A mutation-probe driver. Apply -> measure -> RESTORE -> verify restore.
#   $1 file  $2 find-string  $3 replace-string  $4... detector command
set -u
REPO=/home/user/SchedulePoint
FILE="$1"; FIND="$2"; REPL="$3"; shift 3
cd "$REPO" || exit 9

echo "=== MUTATION PROBE ==="
echo "file    : $FILE"
echo "find    : $FIND"
echo "replace : $REPL"
echo "detector: $*"
echo

BEFORE_SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
echo "sha256 before: $BEFORE_SHA"

python3 - "$FILE" "$FIND" "$REPL" <<'PY'
import sys
path, find, repl = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
n = s.count(find)
if n != 1:
    print(f"ABORT: the find string occurs {n} times (need exactly 1)"); sys.exit(3)
open(path, 'w', encoding='utf-8').write(s.replace(find, repl))
print("patch applied")
PY
if [ $? -ne 0 ]; then echo "PROBE ABORTED (patch did not apply)"; exit 3; fi

echo "sha256 after : $(sha256sum "$FILE" | cut -d' ' -f1)"
echo
echo "--- the applied diff -------------------------------------------------"
git --no-pager diff -- "$FILE"
echo "----------------------------------------------------------------------"
echo
echo "=== DETECTOR, WITH THE MUTATION IN PLACE ==="
"$@"
DET=$?
echo "DETECTOR_EXIT=$DET"
echo

echo "=== RESTORE ==="
git checkout -- "$FILE"
AFTER_SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
echo "sha256 restored: $AFTER_SHA"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then echo "RESTORE VERIFIED: byte-identical"; else echo "RESTORE FAILED"; exit 4; fi
git --no-pager status --short -- "$FILE"
echo "MUTATION_DETECTED=$([ $DET -ne 0 ] && echo YES || echo NO)"
exit 0
