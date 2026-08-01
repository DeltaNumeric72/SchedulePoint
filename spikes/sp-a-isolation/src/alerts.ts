export type AlertSeverity = 'page' | 'warn' | 'info';

export interface OperationalAlert {
  readonly severity: AlertSeverity;
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/**
 * SPEC-01 §4.2 requires an operational alert at PAGE severity on a read-back
 * mismatch. In the spike the sink is an in-memory array so T-14 can assert
 * consequence (c); in production it is the paging channel.
 */
export class AlertSink {
  readonly alerts: OperationalAlert[] = [];

  emit(alert: Omit<OperationalAlert, 'at'>): void {
    this.alerts.push({ ...alert, at: new Date().toISOString() });
  }

  byCode(code: string): OperationalAlert[] {
    return this.alerts.filter((a) => a.code === code);
  }

  clear(): void {
    this.alerts.length = 0;
  }
}
