#!/usr/bin/env python3
"""SchedulePoint plan validator (docs/fable layer).

Checks the internal consistency of the planning layer: deliverable
completeness, capability coverage, parity totals, milestone mapping,
task-packet references, decision-resolution completeness, link
integrity, and the absence of unresolved blocking language.

It validates documentation, not software. Run alongside
docs/architecture/validate.py and schedulepoint-research/validate.sh.
"""
import os, re, sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, "..", ".."))
failures = []
count = 0

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

def check(name, ok, detail=""):
    global count
    count += 1
    status = "PASS" if ok else "FAIL"
    print("%-92s %s" % (name, status))
    if not ok:
        failures.append((name, detail))
        if detail:
            print("      -> %s" % detail)

# ---- 1. deliverable completeness
DELIVERABLES = ["%02d" % n for n in range(25)]
files = {f for f in os.listdir(BASE) if f.endswith(".md")}
missing = [n for n in DELIVERABLES if not any(f.startswith(n + "-") for f in files)]
check("1a. All 25 numbered deliverables (00-24) exist", not missing, str(missing))
CONTROL = ["ORCHESTRATION","PROJECT-STATUS","EVIDENCE-INDEX","PRODUCT-DECISIONS",
           "ARCHITECTURE-DECISIONS","FEATURE-PARITY-MATRIX","RISK-REGISTER",
           "ASSUMPTIONS","OPEN-QUESTIONS","IMPLEMENTATION-ROADMAP",
           "OPUS-AGENT-RUNBOOK","TEST-TRACEABILITY","CHANGELOG"]
cdir = os.path.join(BASE, "control")
missing_c = [c for c in CONTROL if not os.path.exists(os.path.join(cdir, c + ".md"))]
check("1b. All 13 control documents exist", not missing_c, str(missing_c))

def doc(prefix):
    m = [f for f in files if f.startswith(prefix + "-")]
    return read(os.path.join(BASE, m[0])) if m else ""

matrix   = doc("06")
roadmap  = doc("16")
packets  = doc("23")
resolution = doc("21")

# ---- 2. capability coverage (the 58 CAP ids from the baseline)
baseline = read(os.path.join(REPO, "schedulepoint-research", "reports",
                             "19-schedulepoint-production-capability-baseline.md"))
caps = sorted(set(re.findall(r"^#### (CAP-\d{3})", baseline, re.M)))
check("2a. Baseline defines 58 capabilities", len(caps) == 58, "found %d" % len(caps))
matrix_caps = set(re.findall(r"^\| (\d{3}) \|", matrix, re.M))
missing_m = [c for c in caps if c[-3:] not in matrix_caps]
check("2b. Every capability has a parity-matrix row", not missing_m, str(missing_m))

# every matrix row names a roadmap milestone (M0-M12 or post-M12)
rows = re.findall(r"^\| (\d{3}) \|.*\|\s*([^|]*?)\s*\|\s*[a-z-]+\s*\|$", matrix, re.M)
bad_ms = [r[0] for r in rows if not re.search(r"M\d{1,2}|post-M12|continuous", r[1])]
check("2c. Every parity row maps to a milestone", not bad_ms, str(bad_ms))

# ---- 3. parity totals line matches row count
tally = re.search(r"EXACT or EXACT-leaning:\s*(\d+)\s*·\s*HIGH:\s*(\d+)\s*·\s*EQUIV:\s*(\d+)"
                  r"\s*·\s*REDESIGN:\s*(\d+)\s*·\s*DEFERRED:\s*(\d+)", matrix)
if tally:
    total = sum(int(g) for g in tally.groups())
    check("3a. Parity tallies sum to 58", total == 58, "sum=%d" % total)
else:
    check("3a. Parity tallies sum to 58", False, "tally line not found")

# ---- 4. roadmap structure
ms = re.findall(r"^### (M\d{1,2}) ", roadmap, re.M)
check("4a. Roadmap defines M0..M12", ms and len(set(ms)) == 13, str(sorted(set(ms))))
check("4b. Every milestone has an Exit criterion",
      len(re.findall(r"\*\*Exit", roadmap)) >= 13,
      "found %d" % len(re.findall(r"\*\*Exit", roadmap)))
check("4c. Compact sequence table present (§6a)", "## 6a." in roadmap)

# ---- 5. task packets reference real milestones and required fields
pk = re.findall(r"^## (OPUS-M\d{1,2}-\d{3})", packets, re.M)
check("5a. Exactly three task packets defined", len(pk) == 3, str(pk))
for need in ["Escalation conditions", "Fable review checklist", "Required evidence",
             "Prohibited files", "Acceptance criteria", "Tenant-isolation requirements"]:
    check("5b. Packets carry field: %s (x3)" % need,
          packets.count(need) >= 3, "count=%d" % packets.count(need))
check("5c. Packets are marked not-executed",
      "NOT executed" in packets or "not executed" in packets)

# ---- 6. decision resolution completeness
podecs = ["PO-DEC-%02d" % n for n in
          [1,3,4,5,6,7,9,10,11,12,13,14,15,16,17,19,20,21,22,23]]
miss_pd = [p for p in podecs if p not in resolution]
check("6a. All 20 product decisions appear in the resolution record", not miss_pd, str(miss_pd))
tdgs = ["TDG-%02d" % n for n in range(1, 16)]
miss_t = [t for t in tdgs if t not in resolution]
check("6b. All 15 technology gates resolved", not miss_t, str(miss_t))
for series, n in (("OI-", 7), ("EV-", 8)):
    got = {int(x) for x in re.findall(re.escape(series) + r"(\d)", resolution)}
    check("6c. %s1..%d addressed" % (series, n), got >= set(range(1, n + 1)),
          "found %s" % sorted(got))
check("6d. FD-1..FD-4 present", all("FD-%d" % i in resolution for i in range(1, 5)))

# ---- 7. no unresolved blocking language in live-status docs
live = [read(os.path.join(cdir, c + ".md")) for c in
        ("PROJECT-STATUS", "PRODUCT-DECISIONS", "OPEN-QUESTIONS")]
blockers = [b for b in ["awaiting D-A", "awaiting D-B", "awaiting D-C", "awaiting D-D",
                        "blocks M1 schema freeze: pending"]
            if any(b in t for t in live)]
check("7a. No stale blocking language in live control docs", not blockers, str(blockers))
check("7b. PROJECT-STATUS says implementation not started",
      "not started" in live[0].lower())

# ---- 8. internal link integrity (relative .md links in fable docs)
broken = []
for f in sorted(files):
    text = read(os.path.join(BASE, f))
    for target in re.findall(r"\]\((?!http)([^)#\s]+\.md)", text):
        if not os.path.exists(os.path.normpath(os.path.join(BASE, target))):
            broken.append("%s -> %s" % (f, target))
for c in CONTROL:
    text = read(os.path.join(cdir, c + ".md"))
    for target in re.findall(r"\]\((?!http)([^)#\s]+\.md)", text):
        if not os.path.exists(os.path.normpath(os.path.join(cdir, target))):
            broken.append("control/%s -> %s" % (c, target))
check("8a. All relative markdown links resolve", not broken, str(broken[:6]))

# ---- 9. cross-layer references resolve
for rel in ["docs/reviews/architecture/internal-verification-2026-08-01.md",
            "docs/architecture/specs/SPEC-01-request-context-and-tenant-isolation.md",
            "docs/architecture/specs/SPEC-02-picklist-turn-transaction.md"]:
    check("9a. Referenced file exists: %s" % os.path.basename(rel),
          os.path.exists(os.path.join(REPO, rel)))

# ---- 10. implementation boundary
# RESCOPED 2026-08-01: implementation authorized ("Begin Milestone M0",
# frozen planning checkpoint 2b64a7b). The check now protects the boundary
# the old assertion guarded: no application code inside the docs tree.
bad_code = []
for root, dirs, files in os.walk(os.path.join(REPO, "docs")):
    dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
    for f in files:
        if os.path.splitext(f)[1].lower() in (".ts", ".tsx", ".js", ".sql",
                                              ".tf", ".dockerfile") \
           or (f.endswith(".py") and f != "validate.py"):
            bad_code.append(os.path.relpath(os.path.join(root, f), REPO))
check("10a. Docs tree contains no application code", not bad_code, str(bad_code[:5]))

print()
print("%d assertions, %d passed, %d failed." % (count, count - len(failures), len(failures)))
sys.exit(1 if failures else 0)
