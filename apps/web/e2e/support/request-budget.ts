import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page, Request } from '@playwright/test';

/**
 * Requests-per-interaction recorder (SP-HR-2 / I-10).
 *
 * The browser side of the budget gate. It records how many network requests one
 * named interaction produced and writes the recording where
 * `scripts/gates/request-budget.mjs` can compare it against
 * `scripts/gates/request-budget/budgets.json`.
 *
 * Recording and enforcement are split on purpose: the recorder needs a browser,
 * the gate must be able to fail in CI on a machine where the browser step has
 * already run, and the gate must fail **loudly when a budgeted interaction has
 * no recording at all** — otherwise a broken e2e run would silently satisfy the
 * budget.
 */

const RECORDINGS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/gates/request-budget/recordings',
);

export interface RequestRecording {
  readonly interaction: string;
  readonly project: string;
  readonly requests: readonly { method: string; url: string; resourceType: string }[];
  readonly recordedAt: string;
}

/**
 * Counts every request the page issues while `action` runs.
 *
 * Data URLs and blob URLs are excluded: they are not network requests and
 * counting them would make the budget measure bundling choices rather than
 * request amplification.
 */
export async function recordRequests(
  page: Page,
  interaction: string,
  project: string,
  action: () => Promise<void>,
): Promise<RequestRecording> {
  const requests: { method: string; url: string; resourceType: string }[] = [];

  const listener = (request: Request): void => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    requests.push({ method: request.method(), url, resourceType: request.resourceType() });
  };

  page.on('request', listener);
  try {
    await action();
  } finally {
    page.off('request', listener);
  }

  const recording: RequestRecording = {
    interaction,
    project,
    requests,
    recordedAt: new Date().toISOString(),
  };

  mkdirSync(RECORDINGS_DIR, { recursive: true });
  writeFileSync(
    resolve(RECORDINGS_DIR, `${interaction}.${project}.json`),
    `${JSON.stringify(recording, null, 2)}\n`,
    'utf8',
  );

  return recording;
}
