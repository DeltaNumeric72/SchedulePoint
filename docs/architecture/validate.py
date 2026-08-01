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
for d in ("drafts", "specs", "remediation"):
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
check("4. At least 15 ADRs present (23 after remediation)", len(adrs) >= 15, "found %d" % len(adrs))
EXPECTED_ADRS = [
 "ADR-0016-request-aggregate-and-subtypes.md","ADR-0017-cross-module-unit-of-work.md",
 "ADR-0018-report-snapshot-semantics.md","ADR-0019-audit-assurance-level.md",
 "ADR-0020-solver-runtime-packaging.md","ADR-0021-raw-ingress-enclave.md",
 "ADR-0022-request-scoped-tenant-context.md","ADR-0023-picklist-turn-transaction.md",
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
check("20. The pending count is stated (18 tabled + restored PO-DEC-10 = 19)",
      "= 19 pending decisions" in risks)
sec22 = re.search(r"### 2\.2(.*?)(?=\n### |\Z)", risks, re.S)
check("21. No pending decision is marked approved",
      bool(sec22) and not re.search(r"\bAPPROVED\b", sec22.group(1)))
check("22. PO-DEC-10 is restored to the register as pending, ID preserved",
      "PO-DEC-10" in risks and "`pending`" in risks
      and "original identifier" in risks)

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
    check("37. Manifest records 19 pending decisions, none approved",
          man["decisions"]["pendingCount"] == 19 and
          man["decisions"]["pendingSilentlyApproved"] is False)
    check("38. Manifest records drafts as not installed",
          man["drafts"]["installedAtRepositoryRoot"] is False)
    check("39. Manifest records that nothing is implemented or approved",
          man["implemented"] is False and man["approved"] is False)
except Exception as e:
    check("34-39. Manifest assertions", False, repr(e))


# =====================================================================
# PHASE 14 SEMANTIC CHECKS (40-53) -- added by the Codex-review
# remediation. These assert MEANING, not vocabulary. No earlier check
# was weakened or removed.
# =====================================================================

specs_dir = os.path.join(BASE, "specs")
specs = sorted(f for f in os.listdir(specs_dir) if f.endswith(".md")) if os.path.isdir(specs_dir) else []
spec_text = {f: read(os.path.join(specs_dir, f)) for f in specs}
remed = os.path.join(BASE, "remediation", "codex-review-remediation.md")
remed_text = read(remed) if os.path.exists(remed) else ""
data_doc = doc_text.get("06-data-architecture.md", "")

# ---- 40. every referenced data structure exists in the catalogue
# Structures are declared in 06 as leading table cells `| `name` ...` or `| `name` **TAG**`
declared = set(re.findall(r"^\|\s*~?~?`([a-z_]+)`", data_doc, re.M))
declared |= set(re.findall(r"\*\*`([a-z_]+)`\*\*\s*\*\(NEW", data_doc))
# Structures referenced by the traceability doc's "Primary data structures" rows
ref_rows = re.findall(r"\|\s*\*\*Primary data structures\*\*\s*\|([^|]*)\|", tr)
referenced = set()
for row in ref_rows:
    row = re.sub(r"\*\(.*?\)\*", "", row)              # drop explanatory italics
    # only backticked identifiers are treated as structure references
    for tok in re.findall(r"`([a-z][a-z0-9_]{3,})`", row):
        tok = tok.split(".")[0]
        # column-level references (is_*, *_id, *_hash) are not table names
        if tok.startswith("is_") or tok.endswith(("_id", "_hash", "_ref", "_key")):
            continue
        referenced.add(tok)
unresolved_struct = sorted(s for s in referenced if s not in declared)
check("40. Every referenced data structure exists in the catalogue",
      not unresolved_struct, str(unresolved_struct[:10]))

# ---- 41. invariant IDs unique and single-meaning; 7 blockers present
inv_rows = re.findall(r"^\|\s*\*\*(I-\d\d)\*\*\s*\|([^|]*)\|", doc_text.get("01-architecture-overview.md",""), re.M)
inv_ids = [i for i,_ in inv_rows]
check("41a. Invariant IDs are unique in the registry",
      len(inv_ids) == len(set(inv_ids)), str([i for i in inv_ids if inv_ids.count(i) > 1]))
# I-05 must mean automated scheduling everywhere; the save contract must be I-13
i05_meaning = dict(inv_rows).get("I-05", "")
check("41b. I-05 means exactly one thing (automated scheduling)",
      "utomated scheduling" in i05_meaning, i05_meaning[:60])
# Only a CITATION of I-05 as the save contract is a collision; prose that
# explains the historical collision is not.
save_collision = [f for f, x in all_md.items()
                  if re.search(r"\(I-05\s*[/)]", x)
                  or re.search(r"\*\*I-05\*\*[^\n|]{0,40}\|[^\n]{0,60}Add, New, or Create", x)]
check("41c. The Add/New/Create save contract is I-13, not I-05",
      not save_collision, str(save_collision))
BLOCKERS = ["CAP-001","CAP-002","CAP-003","CAP-006","CAP-032","CAP-055","CAP-057"]
blk_sec = re.search(r"## 3\. Capabilities that block architecture approval(.*?)(?=\n## )", tr, re.S)
blk_txt = blk_sec.group(1) if blk_sec else ""
missing_blk = [b for b in BLOCKERS if b not in blk_txt]
check("41d. All seven report-19 architecture blockers are represented",
      not missing_blk, str(missing_blk))
try:
    man_blk = json.load(open(os.path.join(BASE, "architecture-manifest.json")))["capabilities"]["architectureBlocking"]
    check("41e. Manifest lists all seven architecture blockers",
          sorted(man_blk) == sorted(BLOCKERS), str(sorted(man_blk)))
except Exception as e:
    check("41e. Manifest lists all seven architecture blockers", False, repr(e))

# ---- 42. every referenced decision ID resolves in the canonical register
reg = read(os.path.join(RESEARCH, "24-production-completeness-gates.md")) if os.path.exists(
      os.path.join(RESEARCH, "24-production-completeness-gates.md")) else ""
reg_ids = set(re.findall(r"\|\s*\*\*(PO-DEC-\d\d)\*\*", reg))
used_ids = set(re.findall(r"\b(PO-DEC-\d\d)\b", corpus))
unregistered = sorted(used_ids - reg_ids)
check("42a. Every referenced decision ID is present in the canonical register",
      not unregistered, str(unregistered))
check("42b. PO-DEC-10 is restored to the canonical register",
      "PO-DEC-10" in reg_ids)
check("42c. No decision ID is reused for two subjects in the register",
      len(re.findall(r"\|\s*\*\*PO-DEC-10\*\*", reg)) == 1)

# ---- 43. every capability / ADR / gate / invariant reference resolves
adr_ids_on_disk = {f[:8] for f in adrs}
adr_refs = set(re.findall(r"\b(ADR-\d{4})\b", corpus))
check("43a. Every referenced ADR exists on disk",
      not (adr_refs - adr_ids_on_disk), str(sorted(adr_refs - adr_ids_on_disk)))
cap_refs = set(re.findall(r"\b(CAP-\d{3})\b", corpus))
check("43b. Every referenced capability exists in the baseline",
      not (cap_refs - set(cap_ids)), str(sorted(cap_refs - set(cap_ids))))
gate_refs = set(re.findall(r"\b(G-[A-Z]+)\b", corpus))
check("43c. Every referenced gate is a known gate",
      not (gate_refs - {"G-ARCH","G-BETA","G-PROD","G-CONN"}),
      str(sorted(gate_refs - {"G-ARCH","G-BETA","G-PROD","G-CONN"})))
inv_refs = set(re.findall(r"\bI-(\d\d)\b", corpus))
check("43d. Every referenced invariant ID is defined in the registry",
      not ({("I-"+n) for n in inv_refs} - set(inv_ids)),
      str(sorted({("I-"+n) for n in inv_refs} - set(inv_ids))))

# ---- 44. RLS uses transaction-local context
s01 = spec_text.get("SPEC-01-request-context-and-tenant-isolation.md", "")
check("44a. Tenant context is transaction-local (SET LOCAL / set_config(...,true))",
      ("SET LOCAL" in s01 or "set_config" in s01) and "true" in s01)
check("44b. Connection-checkout tenant context is explicitly withdrawn",
      re.search(r"checkout[^\n]{0,120}(unsafe|withdraw|REPLACE)", corpus, re.I) is not None)
check("44c. FORCE ROW LEVEL SECURITY and non-owner roles are required",
      "FORCE ROW LEVEL SECURITY" in corpus and "non-owner" in corpus)
check("44d. Fail-closed outside the unit of work is stated",
      re.search(r"(zero rows|fail-closed|fail closed)", s01, re.I) is not None)

# ---- 45. published-version mutation prohibited
s05 = spec_text.get("SPEC-05-schedule-version-identity-and-publication.md", "")
check("45a. Published-version immutability is database-enforced (trigger, not prose)",
      "trigger" in s05.lower() and "D-15" in s05)
check("45b. Version-scoped overlap constraint (D-1a) exists",
      "D-1a" in data_doc and "version_id WITH =" in s05)
check("45c. Exactly one current version per period (D-16)",
      "D-16" in data_doc)

# ---- 46. picklist one-result-per-turn and aggregate-version invariants
s02 = spec_text.get("SPEC-02-picklist-turn-transaction.md", "")
check("46a. One accepted selection per turn (D-3a) is defined",
      "D-3a" in data_doc and "D-3a" in s02)
check("46b. One claimant per work item (D-3b) is defined", "D-3b" in data_doc)
check("46c. One open turn per picklist (D-3c) is defined", "D-3c" in data_doc)
check("46d. Aggregate version / event sequence invariants exist",
      "aggregate_version" in s02 and "D-12" in s02)
check("46e. Coordinator fencing token is defined", "fencing" in s02.lower() and "D-13" in s02)

# ---- 47. no protected ingestion path accepts unrestricted free text
s03 = spec_text.get("SPEC-03-raw-ingress-trust-boundary.md", "")
wi_row = re.search(r"\|\s*`picklist_work_items`[^\n]*", data_doc)
wi = wi_row.group(0) if wi_row else ""
check("47a. picklist_work_items carries no free-text description field",
      "`description`" not in wi.replace("`description` are REMOVED", ""),
      wi[:120])
check("47b. Work-item labels resolve to a controlled vocabulary",
      "work_item_label_ref" in wi and "work_item_labels" in data_doc)
check("47c. Rejection-not-sanitization is stated",
      re.search(r"[Rr]ejection, never sanitization|reject rather than sanitiz", s03) is not None)
check("47d. Quarantine stores no values and no hashes",
      re.search(r"never.{0,40}hash|NOT ANY HASH|never stores the value", s03 + data_doc, re.I) is not None)

# ---- 48. solver runtime compatible with the selected technology
s04 = spec_text.get("SPEC-04-solver-runtime-and-rule-model.md", "")
check("48a. The solver runtime is an officially supported OR-Tools language",
      re.search(r"\bPython\b", s04) is not None and "S-04" in s04)
NEG_RUNTIME = re.compile(r"(no |not |never |cannot |claiming |withdraw|fails|contradiction|incompatib)", re.I)
bad_runtime = []
for m in re.finditer(r"Node\.js[^\n.]{0,60}(hosts|runs|executes)[^\n.]{0,30}(solver|CP-SAT)", corpus, re.I):
    lead = corpus[max(0, m.start() - 60):m.start()]
    if not NEG_RUNTIME.search(lead):
        bad_runtime.append(m.group(0))
check("48b. No document claims Node.js hosts the solver", not bad_runtime, str(bad_runtime[:2]))
# 48c strengthened 2026-08-01 (internal verification, sweep note): a presence-
# assertion ("a withdrawal statement exists") passed while two documents still
# stated the withdrawn claim. It is now a negative assertion: NO live document
# may state the one-image claim except in a marked-historical line.
HIST = re.compile(r"withdraw|AMENDED|amended|previously|historical|Supersedes|"
                  r"was wrong|contradic|deleted", re.I)
bad_one_image = []
for fname, text in list(doc_text.items()) + list(spec_text.items()):
    for line in text.splitlines():
        if re.search(r"\bone image\b", line, re.I) and not HIST.search(line):
            bad_one_image.append("%s: %s" % (fname, line.strip()[:70]))
check("48c. No live document states the one-image claim (negative assertion)",
      not bad_one_image, str(bad_one_image[:3]))

# ---- 49. push storage retains usable encrypted delivery material
s07 = spec_text.get("SPEC-07-notification-delivery-contracts.md", "")
push_row = re.search(r"\|\s*`push_registrations`[^\n]*", data_doc)
pr = push_row.group(0) if push_row else ""
check("49a. push_registrations retains retrievable delivery material",
      "delivery_material_ref" in pr, pr[:100])
check("49b. Delivery material is encrypted and role-restricted",
      re.search(r"encrypt", s07, re.I) is not None and "delivery worker" in s07.lower())
check("49c. A separate hash is retained for lookup only",
      "subscription_lookup_hash" in pr or "subscription_lookup_hash" in s07)
check("49d. S-05 (Push API) is recorded as a verified source",
      "S-05" in read(os.path.join(BASE, "references", "official-technical-sources.md")))

# ---- 50. no pending product decision silently implemented as approved
approved_ids = {"PO-DEC-00","PO-DEC-02","PO-DEC-04","PO-DEC-08","PO-DEC-18"}
pending_ids = sorted(reg_ids - approved_ids)
check("50a. Pending decisions outnumber approved and total 19",
      len(pending_ids) == 19, "%d pending: %s" % (len(pending_ids), pending_ids))
bad_approve = []
for pid in pending_ids:
    for m in re.finditer(re.escape(pid) + r"[^\n]{0,80}", corpus):
        seg = m.group(0)
        if re.search(r"\bAPPROVED\b", seg) and "not" not in seg.lower():
            bad_approve.append(seg[:70])
check("50b. No pending decision is described as approved",
      not bad_approve, str(bad_approve[:3]))
check("50c. PO-DEC-01's non-default branch creates no tables",
      "~~`sites`~~" in data_doc or "REMOVED (CAR-021)" in data_doc)
# 50d updated 2026-08-01: PO-DEC-03 was resolved under delegated authority.
# The check now asserts the RESOLUTION is recorded (with the resolution record
# referenced) and that SPEC-08 no longer claims the decision remains pending
# outside marked-historical text.
s08 = spec_text.get("SPEC-08-request-subtype-lifecycles.md", "")
res_recorded = ("PO-DEC-03 is RESOLVED" in s08 or
                re.search(r"PO-DEC-03 was resolved", s08, re.I)) and \
               "21-decision-resolution.md" in s08
stale_pending = [l.strip()[:70] for l in s08.splitlines()
                 if re.search(r"PO-DEC-03[^\n]{0,60}remains\s+`?pending", l)
                 and not HIST.search(l)]
check("50d. PO-DEC-03 resolution is recorded in SPEC-08 (no live pending claim)",
      bool(res_recorded) and not stale_pending, str(stale_pending[:2]))

# ---- 51. no exactly-once external delivery claim
NEG_EO = re.compile(r"(never|not|no longer|withdraw|is at-least-once|cannot|does not)", re.I)
bad_eo = []
for m in re.finditer(r"[Ee]xactly[- ]once[^\n.]{0,70}", corpus):
    seg = m.group(0)
    ctx = corpus[max(0, m.start() - 80):m.end() + 40]
    if not re.search(r"(external|provider|delivery)", seg, re.I):
        continue                       # "domain state is exactly-once" is correct
    if NEG_EO.search(ctx):
        continue                       # explicitly disclaimed
    bad_eo.append(seg)
check("51a. No unqualified claim of exactly-once external delivery",
      not bad_eo, str(bad_eo[:3]))
check("51b. Ambiguous and unresolved delivery outcomes exist",
      "ambiguous" in s07.lower() and "unresolved" in s07.lower())

# ---- 52. no application or infrastructure artifacts created
CODE_EXT = {".ts",".tsx",".js",".jsx",".sql",".py",".yaml",".yml",".tf",".dockerfile",
            ".sh",".rb",".go",".java",".cs",".proto",".prisma"}
arte = []
# RESCOPED 2026-08-01: implementation was authorized by the product owner
# ("Begin Milestone M0", commit 2b64a7b is the frozen planning checkpoint).
# The planning-phase assertion "no implementation artifact exists anywhere"
# is therefore retired and replaced by the boundary it was protecting:
# documentation and research trees stay free of application code, and
# implementation lives only in authorized top-level locations.
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build",
             "__pycache__", ".worktrees", ".pnpm-store", "coverage"}
ALLOWED_IMPL_ROOTS = ("spikes", "apps", "packages", "solver", "scripts",
                      ".github", "docs/evidence")
for root, dirs, files in os.walk(REPO):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        full = os.path.join(root, f)
        rel = os.path.relpath(full, REPO)
        if ext in CODE_EXT and os.path.basename(full) not in ("validate.py",) \
           and (rel.startswith("docs/") or rel.startswith("schedulepoint-research/")):
            arte.append(rel)
check("52a. Documentation and research trees contain no application code",
      not arte, str(arte[:6]))
stray = []
for entry in sorted(os.listdir(REPO)):
    full = os.path.join(REPO, entry)
    if not os.path.isdir(full) or entry in SKIP_DIRS or entry.startswith("."):
        continue
    if entry in ("docs", "schedulepoint-research"):
        continue
    if not any((entry + "/").startswith(a.split("/")[0] + "/") for a in ALLOWED_IMPL_ROOTS):
        stray.append(entry + "/")
check("52b. Implementation exists only in authorized locations", not stray, str(stray[:6]))

# ---- 53. SBX heading count vs every declared count (CAR-026 detector)
sbx_plan = os.path.join(RESEARCH, "18-targeted-sandbox-test-plan.md")
if os.path.exists(sbx_plan):
    plan = read(sbx_plan)
    unique_sbx = sorted(set(re.findall(r"^#{2,4}\s+(SBX-\d{3}[a-c]?)", plan, re.M)))
    declared_counts = set(int(n) for n in re.findall(r"(\d+)\s+sandbox tests", plan))
    check("53a. Report 18 defines 39 unique SBX tests", len(unique_sbx) == 39,
          "found %d" % len(unique_sbx))
    mismatch = sorted(c for c in declared_counts if c != len(unique_sbx))
    # CAR-026 is deliberately OPEN: modifying a research source was not
    # authorized. The validator therefore asserts that the discrepancy and
    # its recorded disposition AGREE -- it does not demand the source be
    # edited, and it does not let the discrepancy pass unrecorded.
    car026_open = bool(re.search(r"### CAR-026.*?\*\*Claimed status:\*\*\s*\*\*OPEN\*\*",
                                 remed_text, re.S))
    check("53b. CAR-026 disposition matches reality "
          "(prose count %s vs %d headings; recorded OPEN=%s)"
          % (sorted(declared_counts), len(unique_sbx), car026_open),
          (not mismatch and not car026_open) or (mismatch and car026_open),
          "a mismatch must be recorded OPEN; a fixed count must not be")
    try:
        man = json.load(open(os.path.join(BASE, "architecture-manifest.json")))
        check("53c. Manifest SBX total matches the headings",
              man["sandboxTests"]["total"] == len(unique_sbx))
    except Exception as e:
        check("53c. Manifest SBX total matches the headings", False, repr(e))

# ---- 54. remediation record completeness
check("54a. Remediation record exists", bool(remed_text))
car_ids = ["CAR-%03d" % n for n in range(1, 28)]
missing_car = [c for c in car_ids if ("### " + c + " ") not in remed_text]
check("54b. All 27 findings are dispositioned", not missing_car, str(missing_car))
REQ = ["**Disposition:**","**Changed:**","**Architectural resolution:**","**ADRs:**",
       "**Capabilities:**","**Architecture test:**","**Remaining evidence:**",
       "**Remaining risk:**","**Claimed status:**"]
blocks = re.split(r"\n### (?=CAR-)", remed_text)
incomplete_car = []
for b in blocks:
    m = re.match(r"(CAR-\d{3})", b)
    if not m: continue
    miss = [f for f in REQ if f not in b]
    if miss: incomplete_car.append((m.group(1), miss))
check("54c. Every finding carries all required fields", not incomplete_car,
      str(incomplete_car[:3]))
check("54d. The independent review is unmodified in this package",
      "codex-architecture-review.md" not in str(
          [f for f in all_md if "review" in f.lower()]))

# =====================================================================
# INTERNAL-VERIFICATION CHECKS (55) -- added 2026-08-01 after the
# internal adversarial verification review, which found that three
# checks asserted the PRESENCE of a withdrawal instead of the ABSENCE
# of the withdrawn claim. These are absence assertions.
# =====================================================================

# ---- 55a. no live document states connect-time-only context resolution
bad_connect = []
adr_dir = os.path.join(BASE, "decisions")
adr_text = {f: read(os.path.join(adr_dir, f)) for f in os.listdir(adr_dir)
            if f.endswith(".md")}
for fname, text in (list(doc_text.items()) + list(spec_text.items())
                    + list(adr_text.items())):
    for line in text.splitlines():
        if re.search(r"at connect time|resolved at connect(?!ion)", line, re.I) \
           and not HIST.search(line):
            bad_connect.append("%s: %s" % (fname, line.strip()[:70]))
check("55a. No live document states connect-time-only context/capability resolution",
      not bad_connect, str(bad_connect[:3]))

# ---- 55b. deleted structures are not referenced as live
bad_deleted = []
for fname, text in list(doc_text.items()) + list(spec_text.items()):
    for line in text.splitlines():
        if "assignment_versions" in line and "~~" not in line \
           and not re.search(r"REMOVED|REPLACES|withdraw|AMENDED|amended|deleted|historical|Supersedes|was wrong", line, re.I):
            bad_deleted.append("%s: %s" % (fname, line.strip()[:70]))
check("55b. Deleted table `assignment_versions` is never referenced as live",
      not bad_deleted, str(bad_deleted[:3]))

# ---- 55c. a decision described as resolved requires the resolution record
res_path = os.path.join(REPO, "docs", "fable", "21-decision-resolution.md")
res_text = read(res_path) if os.path.exists(res_path) else ""
bad_resolved = []
for m in re.finditer(r"(PO-DEC-\d{2})[^\n]{0,100}", corpus):
    seg = m.group(0)
    if re.search(r"\bRESOLVED\b|\bratified\b|\bsettled\b", seg) \
       and "not resolved" not in seg.lower():
        if m.group(1) not in res_text:
            bad_resolved.append(seg[:70])
check("55c. Every decision described as resolved appears in the resolution record",
      os.path.exists(res_path) and not bad_resolved, str(bad_resolved[:3]))

# ---- 55d. module-count self-consistency in document 04
d04 = doc_text.get("04-domain-boundaries.md", "")
m_sections = len(re.findall(r"^#### M-\d{2}", d04, re.M))
stated = re.search(r"\*\*(\d+) modules?\*\*", d04)
bad_1919 = [l.strip()[:70] for l in d04.splitlines()
            if re.search(r"25 to 19|rationalised.{0,20}19", l) and not HIST.search(l)]
check("55d. Document 04 module count is self-consistent (stated == defined; no live 25-to-19 claim)",
      bool(stated) and int(stated.group(1)) == m_sections and not bad_1919,
      "stated=%s defined=%d %s" % (stated.group(1) if stated else "?", m_sections, bad_1919[:1]))

# ---- 55e. corrections record dispositions every internal-verification finding
ivc = read(os.path.join(BASE, "remediation", "internal-verification-corrections.md")) \
      if os.path.exists(os.path.join(BASE, "remediation", "internal-verification-corrections.md")) else ""
v_ids = ["V-%02d" % n for n in range(1, 32) if n not in (19, 25)]  # V-19 withdrawn, V-25 counted at V-07
missing_v = [v for v in v_ids if v not in ivc]
check("55e. Every internal-verification finding is dispositioned in the corrections record",
      bool(ivc) and not missing_v, str(missing_v[:5]))

# ------------------------------------------------------ report
fails = [r for r in results if not r[1]]
width = max(len(r[0]) for r in results)
for name, ok, detail in results:
    print("%-*s  %s%s" % (width, name, "PASS" if ok else "FAIL",
                          ("  <- " + detail) if (detail and not ok) else ""))
print("\n%d assertions, %d passed, %d failed." % (len(results), len(results) - len(fails), len(fails)))
sys.exit(1 if fails else 0)
