/**
 * Port registry marker.
 *
 * The domain declares ports; infrastructure implements them. This constant is
 * the scaffold's proof that the package compiles, is importable, and exports a
 * runtime value — nothing more. It is not domain logic and carries no rules.
 */
export const ports = {
  /** Declared in `./unit-of-work.ts`; implemented in `apps/api` (OPUS-M0-001 lands here). */
  unitOfWork: 'UnitOfWorkRunner',
} as const;

export type PortName = keyof typeof ports;
