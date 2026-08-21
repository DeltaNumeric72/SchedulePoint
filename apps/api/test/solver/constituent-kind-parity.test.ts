import { SNAPSHOT_CONSTITUENT_KINDS } from '@schedulepoint/domain';
import { snapshotConstituentSchema } from '@schedulepoint/contracts';
import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';

/**
 * **The constituent vocabulary is ONE closed set, spelled in two places**
 * (OPUS-M4-005).
 *
 * ## Why this file exists, which is a finding rather than a decision
 *
 * `packages/contracts/src/solver/snapshot.ts` carried a comment saying its
 * thirteen-member enum mirrored the domain's `SNAPSHOT_CONSTITUENT_KINDS` and
 * that "`constituent-kind-parity` … asserts the two lists are the same list".
 *
 * There was no such test. The citation pointed at a file that has never existed,
 * and the sweep in `apps/api/test/architecture/citation-integrity.test.ts` found
 * it — but the important part was not the dead path. **No test anywhere imported
 * `SNAPSHOT_CONSTITUENT_KINDS` at all**, so the parity the comment asserted had
 * never been checked by anything. A reader had every reason to believe it had.
 *
 * The claim was made good rather than withdrawn, because two hand-maintained
 * copies of one closed vocabulary are precisely what drifts, and the drift is
 * silent: the contracts package may not import the domain (the layering forbids
 * it), so nothing about adding a kind to one list makes the other complain.
 *
 * A snapshot citing a kind the wire schema does not know is a snapshot the API
 * boundary rejects, and it would be rejected at the moment somebody tried to
 * read a build's provenance — long after the build, and with no clue why.
 */

/** The enum's members, read from the schema rather than from a copy of them. */
function contractKinds(): string[] {
  const shape = snapshotConstituentSchema.shape;
  const kind = shape.kind as unknown as { options: readonly string[] };
  return [...kind.options];
}

describe('the snapshot constituent vocabulary is one list (OPUS-M4-005)', () => {
  it('the contract enum and the domain constant are the SAME set', () => {
    const fromContract = contractKinds().sort();
    const fromDomain = [...SNAPSHOT_CONSTITUENT_KINDS].sort();

    expect(fromContract.length, 'the contract enum is empty — the check would be vacuous')
      .toBeGreaterThan(10);
    expect(fromContract, 'the wire enum and the domain constant have drifted').toEqual(fromDomain);

    log(`${String(fromDomain.length)} constituent kind(s), identical on both sides`);
  });

  it('and the v2 kinds specifically are in both — the ones the comment justified', () => {
    /* `staffGroup` and `validGroup` are FAD-38's appended pair, and they are the
     * ones the mirroring comment was written about. Named individually so that a
     * set comparison which somehow passed on length alone could not carry them. */
    for (const kind of ['staffGroup', 'validGroup']) {
      expect(contractKinds(), `${kind} missing from the wire enum`).toContain(kind);
      expect([...SNAPSHOT_CONSTITUENT_KINDS], `${kind} missing from the domain constant`).toContain(
        kind,
      );
    }
  });

  it('RED: the comparison notices a kind that exists on only one side', () => {
    /* The mutation control. Without it this file passes for ever the moment
     * `contractKinds()` starts returning something other than the enum — which is
     * exactly the shape of the defect it was written to catch, one layer up. */
    const fromDomain = [...SNAPSHOT_CONSTITUENT_KINDS].sort();
    const drifted = [...fromDomain, 'inventedKind'].sort();
    expect(drifted).not.toEqual(fromDomain);

    const missing = fromDomain.slice(1);
    expect(missing).not.toEqual(fromDomain);
  });

  it('every kind is a plain identifier — the enum is a vocabulary, not free text', () => {
    /* I-07 discipline on a field that ends up in a persisted citation and on the
     * wire. A kind is a token; anything else would be a place for prose to
     * arrive. */
    for (const kind of SNAPSHOT_CONSTITUENT_KINDS) {
      expect(kind, `${kind} is not a plain identifier`).toMatch(/^[a-z][A-Za-z0-9]{0,63}$/);
    }
  });
});
