#!/usr/bin/env python3
"""Structural validation for the SchedulePoint architecture proposal.

Validates DOCUMENTATION, not software. It asserts the requirements the
architecture task operated under -- not generic file checks.

Usage:  python3 docs/architecture/validate.py
Exit 0 = all assertions hold. Exit 1 = at least one failed.
"""
import json, os, re, sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, "..", ".."))
RESEARCH = os.path.join(REPO, "schedulepoint-research", "reports")

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

# ---------------------------------------------------------------- inputs
docs = sorted(f for f in os.listdir(BASE) if re.match(r"^\d\d-.*\.md$", f))
adr_dir = os.path.join(BASE, "decisions")
adrs = sorted(f for f in os.listdir(adr_dir) if f.endswith(".md")) if os.path.isdir(adr_dir) else []
doc_text = {f: read(os.path.join(BASE, f)) for f in docs}
adr_text = {f: read(os.path.join(adr_dir, f)) for f in adrs}
all_md = dict(doc_text)
all_md["README.md"] = read(os.path.join(BASE, "README.md")) if os.path.exists(os.path.join(BASE, "README.md")) else ""
for d in ("drafts",):
    p = os.path.join(BASE, d)
    if os.path.isdir(p):
        for f in os.listdir(p):
            if f.endswith(".md"):
                all_md[d + "/" + f] = read(os.path.join(p, f))
for f, t in adr_text.items():
    all_md["decisions/" + f] = t
corpus = "\n".join(all_md.values())

# capability ids from the authoritative baseline report
baseline = os.path.join(RESEARCH, "19-schedulepoint-production-capability-baseline.md")
cap_ids = []
if os.path.exists(baseline):
    cap_ids = re.findall(r"^#{2,4}\s+(CAP-\d{3})\s*\u00b7", read(baseline), re.M)
cap_ids = sorted(set(cap_ids))

tr = doc_text.get("18-capability-traceability.md", "")
risks = doc_text.get("19-risks-and-decisions.md", "")

# ------------------------------------------------------- 1. completeness
check("1. README.md present", os.path.exists(os.path.join(BASE, "README.md")))
check("2. architecture-manifest.json present", os.path.exists(os.path.join(BASE, "architecture-manifest.json")))
expected_docs = ["%02d-" % n for n in range(1, 20)]
missing = [p for p in expected_docs if not any(d.startswith(p) for d in docs)]
check("3. All 19 numbered documents present", not missing, "missing prefixes: %s" % missing)
check("4. Exactly 15 ADRs present", len(adrs) == 15, "found %d" % len(adrs))
EXPECTED_ADRS = [
 "ADR-0001-application-topology.md","ADR-0002-primary-technology-stack.md",
 "ADR-0003-database-and-tenancy-strategy.md","ADR-0004-authorization-architecture.md",
 "ADR-0005-entitlement-architecture.md","ADR-0006-solver-architecture.md",
 "ADR-0007-schedule-versioning.md","ADR-0008-realtime-picklist-transport.md",
 "ADR-0009-job-and-event-reliability.md","ADR-0010-notification-architecture.md",
 "ADR-0011-ingestion-privacy-boundary.md","ADR-0012-connector-architecture.md",
 "ADR-0013-audit-architecture.md","ADR-0014-file-and-report-storage.md",
 "ADR-0015-deployment-topology.md"]
check("5. ADR filenames match those referenced by the documents",
      sorted(adrs) == sorted(EXPECTED_ADRS), str(set(EXPECTED_ADRS) ^ set(adrs)))
check("6. Mermaid diagram sources present",
      os.path.isdir(os.path.join(BASE, "diagrams")) and
      len([f for f in os.listdir(os.path.join(BASE, "diagrams")) if f.endswith(".mmd")]) >= 3)
check("7. Verified-source reference file present",
      os.path.exists(os.path.join(BASE, "references", "official-technical-sources.md")))
check("8. Draft agent-guidance files present",
      os.path.exists(os.path.join(BASE, "drafts", "CLAUDE.md")) and
      os.path.exists(os.path.join(BASE, "drafts", "AGENTS.md")))

# --------------------------------------------------------- 2. ADR shape
ADR_SECTIONS = ["## Context", "## Decision", "## Alternatives considered",
                "## Consequences", "## Security implications",
                "## Operational implications", "## Capability mappings",
                "## Gate mappings", "## Unresolved validation"]
bad = {f: [s for s in ADR_SECTIONS if s not in t] for f, t in adr_text.items()}
bad = {f: v for f, v in bad.items() if v}
check("9. Every ADR has all nine required sections", not bad, str(bad))
no_status = [f for f, t in adr_text.items() if "**Status:** `PROPOSED`" not in t]
check("10. Every ADR is marked PROPOSED", not no_status, str(no_status))
accepted = [f for f, t in adr_text.items()
            if re.search(r"\*\*Status:\*\*[^\n]*?(?<!Not )\bACCEPTED\b", t)]
check("11. No ADR is marked accepted", not accepted, str(accepted))

# ------------------------------------------------- 3. capability coverage
check("12. Capability ids read from the baseline report", len(cap_ids) == 58, "found %d" % len(cap_ids))
unmapped = [c for c in cap_ids if ("### " + c + " ") not in tr]
check("13. All 58 capabilities appear in the traceability document", not unmapped, str(unmapped))
FIELDS = ["**Disposition**","**Milestone**","**Gate**","**Features**","**Entities**",
          "**State machines**","**Architecture document**","**Modules**",
          "**Primary data structures**","**Interfaces / ports**",
          "**Background / async work**","**Real-time involvement**",
          "**Authorization requirement**","**Privacy / security consideration**",
          "**Testing strategy**","**ADRs**","**Open questions / confidence**"]
blocks = re.split(r"\n### (?=CAP-)", tr)
incomplete = []
for b in blocks:
    m = re.match(r"(CAP-\d{3})", b)
    if not m:
        continue
    miss = [f for f in FIELDS if f not in b]
    if miss:
        incomplete.append((m.group(1), miss))
check("14. Every capability entry carries all 17 mapping fields", not incomplete, str(incomplete[:3]))
future_only = [c for c in cap_ids
               if re.search(r"### %s .*?\n\n(.*?)(?=\n### |\Z)" % c, tr, re.S) and
               "future work" in re.search(r"### %s .*?\n\n(.*?)(?=\n### |\Z)" % c, tr, re.S).group(1).lower()]
check("15. No capability is mapped only to future work", not future_only, str(future_only))

# ------------------------------------------- 4. prohibited vocabulary
BANNED = ["excluded", "abandoned", "optional because difficult",
          "indefinitely deferred", "post-mvp"]
disp_lines = re.findall(r"\|\s*\*\*Disposition\*\*\s*\|([^|]*)\|", tr)
viol = [d.strip() for d in disp_lines if any(b in d.lower() for b in BANNED)]
check("16. No capability carries a prohibited disposition", not viol, str(viol))
check("17. Every capability has a production gate",
      all(re.search(r"\|\s*\*\*Gate\*\*\s*\|\s*`G-(ARCH|BETA|PROD|CONN)`", b)
          for b in blocks if re.match(r"CAP-\d{3}", b)))

# ------------------------------------------------------ 5. decisions
approved = ["PO-DEC-00","PO-DEC-02","PO-DEC-04","PO-DEC-08","PO-DEC-18"]
pending = ["PO-DEC-01","PO-DEC-03","PO-DEC-05","PO-DEC-06","PO-DEC-07","PO-DEC-09",
           "PO-DEC-11","PO-DEC-12","PO-DEC-13","PO-DEC-14","PO-DEC-15","PO-DEC-16",
           "PO-DEC-17","PO-DEC-19","PO-DEC-20","PO-DEC-21","PO-DEC-22","PO-DEC-23"]
check("18. All five approved decisions are recorded",
      all(d in risks for d in approved), str([d for d in approved if d not in risks]))
check("19. All eighteen pending decisions are retained",
      all(d in risks for d in pending), str([d for d in pending if d not in risks]))
check("20. The pending count is stated as 18", "**Count: 18.**" in risks)
sec22 = re.search(r"### 2\.2(.*?)(?=\n### |\Z)", risks, re.S)
check("21. No pending decision is marked approved",
      bool(sec22) and not re.search(r"\bAPPROVED\b", sec22.group(1)))
check("22. The PO-DEC-10 register discrepancy is flagged, not resolved",
      "PO-DEC-10" in risks and "not resolved here" in risks)

# ------------------------------------------------------ 6. no overclaim
NEG = re.compile(r"\b(no|not|never|none|cannot|neither)\b", re.I)
affirmed = []
for m in re.finditer(r"gate\b[^.\n|]{0,40}\b(?:is|has been|was)\s+passed", corpus, re.I):
    lead = corpus[max(0, m.start() - 30):m.start()]
    if not NEG.search(lead):
        affirmed.append(corpus[max(0, m.start() - 30):m.end()].replace("\n", " "))
check("23. No gate is declared passed", not affirmed, str(affirmed[:3]))
check("24. Package states explicitly that no test has been executed",
      "No test has been executed" in all_md.get("README.md", ""))
BAD_COMPLIANCE = [r"\bis HIPAA[- ]compliant", r"\bHIPAA[- ]certified", r"\bSOC ?2[- ]certified",
                  r"\bis SOC ?2 compliant", r"\bwe are compliant with"]
hits = [p for p in BAD_COMPLIANCE if re.search(p, corpus, re.I)]
check("25. No compliance certification is claimed", not hits, str(hits))
check("26. Security document explicitly disclaims compliance",
      "No compliance claim is made" in doc_text.get("14-security-and-privacy.md", ""))
check("27. Every document is marked PROPOSED",
      all("`PROPOSED`" in t for t in doc_text.values()),
      str([f for f, t in doc_text.items() if "`PROPOSED`" not in t]))

# --------------------------------------------- 7. clean-room and safety
LEAKS = ["Trillium", "THP", "ischedule.md/users", "@ischedule"]
found = sorted({w for w in LEAKS if w in corpus})
check("28. No tenant or customer identifier appears in the architecture package",
      not found, str(found))
check("29. Clean-room boundary stated in the README",
      "Clean-room boundary" in all_md.get("README.md", ""))
check("30. Synthetic-data-only constraint stated in the testing document",
      "Synthetic data only" in doc_text.get("16-testing-and-environments.md", ""))

# ------------------------------------- 8. no implementation was produced
allowed_ext = {".md", ".mmd", ".json", ".py"}
stray = []
for root, _, files in os.walk(BASE):
    for f in files:
        if os.path.splitext(f)[1] not in allowed_ext:
            stray.append(os.path.relpath(os.path.join(root, f), BASE))
check("31. No application source, migration, or infrastructure file in the package",
      not stray, str(stray))
check("32. Drafts are NOT installed at the repository root",
      not os.path.exists(os.path.join(REPO, "CLAUDE.md")) and
      not os.path.exists(os.path.join(REPO, "AGENTS.md")))

# ------------------------------------------------------ 9. link integrity
broken = []
for name, text in all_md.items():
    d = os.path.dirname(os.path.join(BASE, name))
    for target in re.findall(r"\]\(([^)#][^)]*)\)", text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        path = os.path.normpath(os.path.join(d, target.split("#")[0]))
        if not os.path.exists(path):
            broken.append("%s -> %s" % (name, target))
check("33. Every relative link resolves", not broken, str(broken[:6]))

# ------------------------------------------------------ 10. manifest
try:
    man = json.load(open(os.path.join(BASE, "architecture-manifest.json")))
    check("34. Manifest is valid JSON and marked PROPOSED", man.get("status") == "PROPOSED")
    check("35. Manifest capability totals match the baseline",
          man["capabilities"]["total"] == len(cap_ids) and
          man["capabilities"]["mappedInTraceability"] == len(cap_ids))
    check("36. Manifest records no gate as passed",
          all(not g["passed"] for g in man["gates"].values()))
    check("37. Manifest records 18 pending decisions, none approved",
          man["decisions"]["pendingCount"] == 18 and
          man["decisions"]["pendingSilentlyApproved"] is False)
    check("38. Manifest records drafts as not installed",
          man["drafts"]["installedAtRepositoryRoot"] is False)
    check("39. Manifest records that nothing is implemented or approved",
          man["implemented"] is False and man["approved"] is False)
except Exception as e:
    check("34-39. Manifest assertions", False, repr(e))

# ------------------------------------------------------ report
fails = [r for r in results if not r[1]]
width = max(len(r[0]) for r in results)
for name, ok, detail in results:
    print("%-*s  %s%s" % (width, name, "PASS" if ok else "FAIL",
                          ("  <- " + detail) if (detail and not ok) else ""))
print("\n%d assertions, %d passed, %d failed." % (len(results), len(results) - len(fails), len(fails)))
sys.exit(1 if fails else 0)
