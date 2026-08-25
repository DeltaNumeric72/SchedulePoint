import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/http/server.js';
import { log } from '../support/harness.js';

/**
 * **NAMED PROOF — the request log carries no request material** (I-07;
 * non-bypass rule 9; REV-B-008 / FAD-53 repair packet R-7).
 *
 * ## The finding this pins
 *
 * REV-B drove one marker through six wire positions against the real server on
 * the real database and hunted every line the server's own logger wrote. It
 * found none — and filed the result as a NOTE rather than a pass, in its own
 * words:
 *
 * > The honest caveat, which is why this is a NOTE and not a clean pass. Only
 * > **one** log line was captured across six requests. The marker did not reach
 * > the log because on these paths the server writes almost nothing:
 * > `buildServer` sets `disableRequestLogging: true` (so no `req.url` line,
 * > which is what would otherwise carry a query string) […] That is a good
 * > design and it is the reason for the result — but a "0 hits in 1 line"
 * > measurement is a thin haystack.
 *
 * and recommended, explicitly, exactly this:
 *
 * > A standing regression of this shape — marker in, log hunted, needle control
 * > — is cheap and would make rule 9's first clause a tested property rather
 * > than a design intention.
 *
 * ## Why the setting needs a pin at all
 *
 * `disableRequestLogging: true` is one word in `server.ts`, it is what makes the
 * `req.url` line — the line that carries the whole query string — not exist, and
 * **nothing failed if it were deleted.** Fastify's default is to log two lines
 * per request, so removing it does not break a single existing assertion; it
 * silently starts writing every request's URL, for every route, forever. A
 * privacy property that depends on an unasserted default is a property that
 * lasts until somebody enables request logging while debugging.
 *
 * ## What this file asserts, and why in that order
 *
 *  1. the setting itself, off `app.initialConfig` — Fastify's own record of what
 *     it was built with, rather than a string match on the source;
 *  2. the BEHAVIOUR — a marker driven through the query string, the path, and a
 *     header reaches no log line. This is the half that still holds if the
 *     option is renamed or reached another way;
 *  3. the NEEDLE CONTROL — the same hunt, over a line the test plants itself,
 *     DOES find it. Without this, arms 1 and 2 would pass just as well against a
 *     logger that was silently writing nowhere, which is the way a privacy proof
 *     stops existing while still appearing in the evidence (the FAD-50 C-3
 *     lesson, applied to a log rather than to a suite).
 *
 * No database and no tenancy runtime: with no runtime every capability route
 * answers `503` before touching a tenant table, and the question here is what
 * the HTTP layer writes to the log, which is decided before any handler runs.
 */

/** One marker, structurally unmistakable, and synthetic (CLAUDE.md §7). */
const MARKER = 'SP-R7-LOGPIN-4f2c9ad1e6b74c0898fbb0e2c5d31a77';

/** Every raw line the server's logger wrote, in order. */
const lines: string[] = [];

let app: FastifyInstance;

beforeAll(async () => {
  const built = await buildServer({
    logger: {
      /* `trace`, not `info`: the haystack must be as large as the server can
         make it. A pin that only looked at `info` would pass over a request line
         emitted at `debug`, which is precisely where a "just while I debug this"
         change would put it. */
      level: 'trace',
      stream: {
        write(line: string): void {
          lines.push(line);
        },
      },
    },
  });
  app = built.app;
});

afterAll(async () => {
  await app.close();
});

describe('the HTTP layer never writes request material to the log', () => {
  it('the server is BUILT with request logging disabled — Fastify’s own record', () => {
    /* `initialConfig` is what Fastify was constructed with, so this survives a
       refactor of `server.ts` that a source grep would not. */
    expect(app.initialConfig.disableRequestLogging).toBe(true);
  });

  it('a marker driven through query, path and header reaches NO log line', async () => {
    lines.length = 0;

    /* Three of REV-B's six wire positions — the three that do not need a
       database to be reached, and the query string is the one its caveat names
       as "what would otherwise carry a query string". */
    const responses = [
      await app.inject({ method: 'GET', url: `/v1/does-not-exist?probe=${MARKER}` }),
      await app.inject({ method: 'GET', url: `/v1/${MARKER}` }),
      await app.inject({
        method: 'GET',
        url: '/v1/does-not-exist',
        headers: { 'x-sp-probe': MARKER },
      }),
    ];
    /* The requests really happened — an assertion over an empty exchange proves
       nothing. Every one is refused, which is the deny-by-default answer (I-02),
       and refusal is exactly the path a leak would ride out on. */
    for (const response of responses) {
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    }

    const hits = lines.filter((line) => line.includes(MARKER));
    expect(hits, `the marker reached ${String(hits.length)} log line(s)`).toEqual([]);

    /* And the specific shape the setting exists to prevent: Fastify's own
       per-request pair. If `disableRequestLogging` were removed these appear —
       "incoming request" carrying `req.url`, which is the query string. */
    const requestLines = lines.filter(
      (line) => line.includes('"incoming request"') || line.includes('"request completed"'),
    );
    expect(
      requestLines,
      `request logging is ON: ${String(requestLines.length)} line(s)`,
    ).toEqual([]);

    log(
      `REV-B-008 pin: 3 refused requests carrying the marker in query, path and header → ` +
        `${String(lines.length)} log line(s) written, 0 containing it, 0 request lines`,
    );
  });

  it('THE CONTROL: the same hunt DOES find a needle the test plants', () => {
    /* REV-B's own falsifiability control, kept: a line the server's logger really
       wrote, found by the identical filter. Without it, "0 hits" is equally
       consistent with a capture that never received anything. */
    lines.length = 0;
    app.log.info({ probe: MARKER }, 'planted needle');

    const hits = lines.filter((line) => line.includes(MARKER));
    expect(hits.length, 'the log capture itself is not wired up').toBe(1);
    log('needle control: the planted line IS found by the same filter');
  });
});
