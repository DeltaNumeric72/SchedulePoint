import { randomUUID } from 'node:crypto';

import { snapshotRefusals, type SolveRequestSpec } from '@schedulepoint/domain';

import { validateCandidate, type CandidateVerdict } from '../../../src/solver/candidate-validation.js';
import { canonicalInputHash } from '../../../src/solver/snapshot-store.js';
import { solveOnWorker, type SolveOutcomeDetail } from '../../../src/solver/solver-client.js';
import { DETERMINISTIC_PARAMETERS } from '../../support/solver.js';
import { generatedCorpus, type CorpusFixture } from './generators.js';
import { raceProducedRetiredHoldingFixture } from './race-fixture.js';

/**
 * The corpus, assembled — generated fixtures plus the one that cannot be
 * generated.
 *
 * `race-retired-holding` is produced by running the shipped
 * granted-while-retiring interleaving and capturing what it left behind. Doc 35
 * §6d is explicit that it must be "produced by the shipped interleaving harness
 * or a snapshot captured from it, **never hand-written**", and the reason is
 * that a hand-written fixture would encode what somebody BELIEVED the race
 * produces. The whole value of the case is that nobody chose the state.
 */
export async function e1Corpus(): Promise<readonly CorpusFixture[]> {
  return [...generatedCorpus(), await raceProducedRetiredHoldingFixture()];
}

export interface CorpusRun {
  readonly fixture: CorpusFixture;
  readonly outcome: SolveOutcomeDetail;
  /** `null` when the solve returned no candidate — never "passed". */
  readonly verdict: CandidateVerdict | null;
}

/**
 * Pose one fixture to the REAL worker and re-check whatever comes back.
 *
 * The request is built exactly as `dispatchBuild` builds one, and the hash is
 * computed by the platform over the document it is about to send — never taken
 * from the response.
 */
export async function runFixture(fixture: CorpusFixture): Promise<CorpusRun> {
  const document = fixture.document;
  /* A corpus fixture that the assembly would have REFUSED is not a scheduling
   * problem, and a solve of one would be measuring the wrong thing. Checked
   * here rather than only in the manifest test so every consumer of a run gets
   * the guarantee. */
  const refusals = snapshotRefusals(document);
  if (refusals.length > 0) {
    throw new Error(
      `corpus fixture ${fixture.name} would be refused at assembly: ` +
        refusals.map((refusal) => `${refusal.reason}@${refusal.subject}`).join(', '),
    );
  }

  const spec: SolveRequestSpec = {
    protocolVersion: 1,
    organizationId: document.organizationId,
    groupId: document.groupId,
    buildRunId: randomUUID(),
    correlationId: `corpus-${fixture.name}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(document),
    snapshotPayload: document,
    parameters: DETERMINISTIC_PARAMETERS,
  };

  const outcome = await solveOnWorker(spec);
  const verdict =
    outcome.assignments === null
      ? null
      : validateCandidate({
          snapshot: document,
          assignments: outcome.assignments,
          expectedInputHash: spec.canonicalInputHash,
          reportedInputHash: outcome.canonicalInputHash,
        });
  return { fixture, outcome, verdict };
}

/** One line of the per-class run summary the packet asks for in the evidence. */
export function summaryLine(run: CorpusRun): string {
  const { fixture, outcome, verdict } = run;
  const cause =
    outcome.explanation === null
      ? '—'
      : `${outcome.explanation.state}` +
        (outcome.explanation.structural.length > 0
          ? ` T0[${outcome.explanation.structural.map((f) => f.code).join(',')}]`
          : '') +
        (outcome.explanation.conflictingRuleKeys.length > 0
          ? ` T1[${outcome.explanation.conflictingRuleKeys.join(',')}]`
          : '');
  return [
    fixture.corpusClass.padEnd(32),
    fixture.name.padEnd(36),
    `hash ${canonicalInputHash(fixture.document).slice(0, 12)}`,
    `outcome ${outcome.status}/${outcome.terminationReason}`.padEnd(30),
    `hardViolations ${verdict === null ? 'n/a' : String(verdict.hardViolations)}`.padEnd(20),
    `cause ${cause}`,
  ].join(' · ');
}
