/**
 * `packages/domain/src/eligibility` — the shared eligibility verdict
 * (OPUS-M4-000A; doc 34 §4-B; doc 35 §2 marks this directory as created by
 * 000A and FROZEN to 000B/000C, which consume it read-only).
 */
export {
  evaluateEligibility,
  qualificationOutcome,
  QUALIFICATION_OUTCOMES,
  type EligibilityInput,
  type EligibilityVerdict,
  type MembershipVerdict,
  type QualificationLifecycle,
  type QualificationOutcome,
  type QualificationVerdict,
  type VerdictHolding,
  type WorkProfileVerdict,
} from './verdict.js';
