import type { AlertSink, OperationalAlert } from '@schedulepoint/domain';

/**
 * The operational alert sink.
 *
 * SPEC-01 §4.2 (V-10) requires an alert at **page** severity on a read-back
 * mismatch, and explicitly prohibits logging-and-continuing. This adapter writes
 * to stderr as structured JSON, which is what the deployment's log shipper turns
 * into a page; it also retains the alerts in memory so a test can assert
 * consequence (c) directly rather than by scraping output.
 *
 * The retained buffer is bounded. An unbounded alert buffer in a process that is
 * paging is a second incident.
 */

const MAX_RETAINED = 256;

export class ProcessAlertSink implements AlertSink {
  readonly #retained: OperationalAlert[] = [];
  readonly #write: (line: string) => void;

  constructor(options: { write?: (line: string) => void } = {}) {
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  emit(alert: Omit<OperationalAlert, 'at'>): void {
    const full: OperationalAlert = { ...alert, at: new Date().toISOString() };
    this.#retained.push(full);
    if (this.#retained.length > MAX_RETAINED) this.#retained.shift();
    this.#write(JSON.stringify({ alert: full }));
  }

  /** Every alert retained, newest last. */
  get alerts(): readonly OperationalAlert[] {
    return this.#retained;
  }

  byCode(code: string): readonly OperationalAlert[] {
    return this.#retained.filter((alert) => alert.code === code);
  }

  clear(): void {
    this.#retained.length = 0;
  }
}
