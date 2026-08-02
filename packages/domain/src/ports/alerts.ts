/**
 * The operational alert port.
 *
 * SPEC-01 §4.2 (V-10) makes one alert non-optional: a read-back mismatch raises
 * an operational alert **at page severity**, in addition to aborting the
 * transaction and discarding the connection. All three are asserted by T-14.
 *
 * > Logging and continuing is explicitly prohibited — this read-back is the
 * > single detector for the TDG-02/TDG-03 failure mode the whole design rests on.
 *
 * The port exists so the unit-of-work runner can raise that alert without
 * knowing what the paging channel is, and so a test can assert the alert was
 * raised rather than inspecting a log.
 */

export type AlertSeverity = 'page' | 'warn' | 'info';

export interface OperationalAlert {
  readonly severity: AlertSeverity;
  /** Stable machine-readable code, screaming snake case. */
  readonly code: string;
  readonly message: string;
  /**
   * Structured operator-facing detail.
   *
   * **Never a payload body, a contact value, or delivery material** (I-07, I-17,
   * SPEC-07 §3). Tenant identifiers and a correlation id are permitted; anything
   * a user typed is not.
   */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface AlertSink {
  emit(alert: Omit<OperationalAlert, 'at'>): void;
}
