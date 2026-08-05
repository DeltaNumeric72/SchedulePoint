import type { CandidateList } from '@schedulepoint/contracts';
import { describe, expect, it } from 'vitest';

import { decideEligibilityOffer } from '../src/schedule/eligibility-offer.js';

/**
 * The eligibility absent-vs-empty ruling (OPUS-M3-004).
 *
 * The ruling is a three-valued distinction that a two-valued implementation
 * would silently collapse, so the test that matters is the one asserting the
 * third value survives: **absent is never rendered as ineligible.**
 */

function list(overrides: Partial<CandidateList> = {}): CandidateList {
  return {
    date: '2028-01-02',
    shiftTypeId: '11111111-1111-4111-8111-111111111111',
    eligibilityKnown: true,
    candidates: [],
    correlationId: 'test-correlation-id',
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    membershipId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Synthetic Member',
    staffingKind: 'staff' as const,
    eligible: true as boolean | null,
    missingQualificationIds: [] as string[],
    alreadyAssigned: false,
    ...overrides,
  };
}

describe('ABSENT — the caller cannot see credentials at all', () => {
  const offer = decideEligibilityOffer(
    list({
      eligibilityKnown: false,
      candidates: [candidate({ eligible: null }), candidate({ eligible: null })],
    }),
  );

  it('reports every candidate as unknown, never as ineligible', () => {
    expect(offer.offers.map((entry) => entry.disposition)).toEqual(['unknown', 'unknown']);
  });

  it('still offers the whole roster — this surface is the override mechanism', () => {
    expect(offer.offers).toHaveLength(2);
  });

  it('requires no override reason, because there is nothing to override', () => {
    expect(offer.offers.every((entry) => !entry.requiresOverrideReason)).toBe(true);
  });

  it('says so in words, and the words are about permission rather than about the person', () => {
    expect(offer.eligibilityAbsent).toBe(true);
    expect(offer.notice).toContain('Eligibility cannot be shown');
    // The sentence must never assert something about the member.
    expect(offer.notice).not.toMatch(/not qualified|ineligible|missing/i);
  });

  it('is NOT the same state as "nobody qualifies"', () => {
    expect(offer.noneEligible).toBe(false);
  });
});

describe('EMPTY — eligibility is known and nobody qualifies', () => {
  const offer = decideEligibilityOffer(
    list({
      eligibilityKnown: true,
      candidates: [
        candidate({ eligible: false, missingQualificationIds: ['33333333-3333-4333-8333-333333333333'] }),
      ],
    }),
  );

  it('reports the candidate as ineligible, with a countable reason', () => {
    expect(offer.offers[0]?.disposition).toBe('ineligible');
    expect(offer.offers[0]?.label).toBe('Missing 1 credential');
  });

  it('requires an override reason — this IS something to override', () => {
    expect(offer.offers[0]?.requiresOverrideReason).toBe(true);
  });

  it('is a different notice from the absent one, and a different flag', () => {
    expect(offer.eligibilityAbsent).toBe(false);
    expect(offer.noneEligible).toBe(true);
    expect(offer.notice).toContain('Nobody in this group holds every credential');
  });
});

describe('a per-row absence is treated per row', () => {
  it('a null candidate inside a KNOWN call is still unknown, not ineligible', () => {
    // The read may return no row for a member and shift type even when the
    // caller can see credentials. That is the same absence, one row at a time.
    const offer = decideEligibilityOffer(
      list({
        eligibilityKnown: true,
        candidates: [candidate({ eligible: null }), candidate({ eligible: true })],
      }),
    );
    expect(offer.offers.map((entry) => entry.disposition)).toEqual(['unknown', 'eligible']);
    expect(offer.noneEligible).toBe(false);
    // A mixed list carries no standing notice: one row's absence is shown on
    // that row, not as a statement about the whole call.
    expect(offer.notice).toBeNull();
  });
});

describe('ELIGIBLE', () => {
  it('is labelled plainly and needs no reason', () => {
    const offer = decideEligibilityOffer(
      list({ eligibilityKnown: true, candidates: [candidate({ eligible: true })] }),
    );
    expect(offer.offers[0]?.disposition).toBe('eligible');
    expect(offer.offers[0]?.label).toBe('Eligible');
    expect(offer.offers[0]?.requiresOverrideReason).toBe(false);
    expect(offer.notice).toBeNull();
  });
});

describe('an empty candidate list is not "nobody eligible"', () => {
  it('reports neither flag when there is nobody to report on', () => {
    // A group with no active members is a different fact from a group whose
    // members are all unqualified, and neither notice would be true.
    const offer = decideEligibilityOffer(list({ eligibilityKnown: true, candidates: [] }));
    expect(offer.offers).toEqual([]);
    expect(offer.noneEligible).toBe(false);
    expect(offer.eligibilityAbsent).toBe(false);
    expect(offer.notice).toBeNull();
  });
});
