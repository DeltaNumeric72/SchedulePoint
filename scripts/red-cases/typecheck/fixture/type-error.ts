/**
 * RED CASE — typecheck.
 *
 * A plain type error. `tsc -b` must reject it.
 */
export function shiftCount(): number {
  const value: string = 'not a number';
  return value;
}
