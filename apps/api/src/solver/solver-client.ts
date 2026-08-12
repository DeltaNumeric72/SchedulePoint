import { spawn } from 'node:child_process';

import {
  MAX_SOLVER_RESPONSE_BYTES,
  SOLVER_PROTOCOL_VERSION,
  SolverResponseRejectedError,
  reproducibilityMode,
  solverResponseVerdict,
  type SolveOutcome,
  type SolveRequestSpec,
  type SolverCandidateAssignment,
  type SolverRuntimeRecord,
} from '@schedulepoint/domain';

import { assertOutsideUnitOfWork } from '../db/provider-boundary.js';
import { DEFAULT_TERMINATION_GRACE_MS, solverRpcKey, solverWorkerCommand } from './config.js';
import { frameRequest, splitFrame, verifyResponseFrame } from './rpc-envelope.js';
import { freshNonce } from './rpc-envelope.js';

/**
 * @provider-port solver
 *
 * **The solver RPC client** — SPEC-04 §§1–2, the first real provider port in the
 * platform.
 *
 * ## The boundary this is written against already refuses
 *
 * OPUS-M4-000C implemented SPEC-12 U-07 *before* any provider existed, and the
 * ordering was deliberate: the structural separation was proven first, so this
 * module is written against a boundary that already says no rather than having
 * one retrofitted around a solver that already works. Concretely —
 *
 *  - the `@provider-port` marker above puts this module in the static gate's
 *    population, so **every exported entry point here must open with
 *    `assertOutsideUnitOfWork(`** or `pnpm check` fails;
 *  - the guard is the first statement of {@link solveOnWorker}, so a caller who
 *    reaches it from inside an open transaction is refused **before** a
 *    subprocess exists — not after, when the effect has already happened;
 *  - this module does not import the unit-of-work runner, and the gate's third
 *    class fails the build if it ever does. A provider that can open a
 *    transaction can put itself inside one.
 *
 * The runtime arm matters more than the static one here, and doc 35 §6a's
 * binding constraint 1 says why: the `AsyncLocalStorage` mark propagates past
 * commit, so work *scheduled* inside a transaction and running after it is still
 * marked. A solve dispatched from a `.then()` hanging off the transaction
 * callback is refused, and a source scan could never see that.
 *
 * ## What crosses the boundary, and what cannot
 *
 * A canonical input document and a set of parameters go out; a status, a
 * termination reason, a candidate and a reproducibility record come back.
 * **No database handle, no credential, no connection string** (SPEC-04 §1.1,
 * S-15t). The worker's own `egress_guard` makes that a runtime property on its
 * side; on this side the guarantee is structural, because there is no field in
 * which a credential could travel.
 *
 * ## Three layers of stopping, and only the third is a guarantee
 *
 * SPEC-04 §2 layers cancellation because the first two can fail:
 *
 *  1. the solver's own deadline (`parameters.maxTimeInSeconds`), inside the worker;
 *  2. the control channel — a sentinel path the worker's **watcher thread**
 *     polls (never a signal: EV-M0-SPC H-4 measured 28 s and a misreported
 *     outcome for the signal path, and FAD-10 made the prohibition architectural);
 *  3. **termination of the subprocess by this module.**
 *
 * Layer 3 is why one solve occupies one subprocess. This module owns the
 * wall-clock timer, sends `SIGTERM`, waits a bounded grace, then `SIGKILL`s, and
 * **reports what actually happened**: a killed solve is `FAILED`/`killed`, never
 * a timeout dressed up as a completion. A terminated worker writes nothing at
 * all, which is exactly why `killed` is attributed here and never self-reported.
 *
 * ## Nothing here logs a payload
 *
 * The problem document is an entire group's staffing input. It never enters a
 * log line, an error message, a span, or a rejection reason (I-07, non-bypass
 * rule 9). Every refusal names structure — a byte count, a status word, a
 * termination reason — and no content.
 */

/** Knobs the *dispatch* needs that the domain request does not carry. */
export interface SolverDispatchOptions {
  /**
   * Path the worker's watcher thread polls. Creating the file requests
   * cancellation; the worker observes it, stops, and reports `CANCELLED`.
   *
   * A path rather than a callback because the observer is a thread in another
   * process, and a filesystem existence check is the one primitive that works
   * from any thread regardless of what the main thread is doing inside a native
   * library — which is the whole reason signals are prohibited.
   */
  readonly cancelFile?: string;
  /** Path the worker writes its pid to once the solve has actually STARTED. */
  readonly readyFile?: string;
  /**
   * Parent wall clock, milliseconds. Defaults to the solver's own budget plus
   * the grace, so layer 3 fires only after layer 1 has genuinely failed to
   * return — a parent timeout tighter than the solver's deadline would kill
   * healthy solves and report them as wedged.
   */
  readonly timeoutMs?: number;
  /** How long a `SIGTERM` is given before `SIGKILL`. SPEC-04 §2's grace period. */
  readonly graceMs?: number;
  /** Stub-solver behaviour selector. Removed when M4-002 lands the real adapter. */
  readonly stubBehaviour?: 'candidate' | 'dwell' | 'wedged';
  readonly stubDwellMs?: number;
}

/**
 * **The provider entry point.** Dispatch one solve to one worker subprocess.
 *
 * The guard is the FIRST statement — what the static gate checks, and what makes
 * the refusal happen before any effect. A guard further down would already have
 * let the caller past it.
 */
export async function solveOnWorker(
  request: SolveRequestSpec,
  options: SolverDispatchOptions = {},
): Promise<SolveOutcome> {
  assertOutsideUnitOfWork('solver');

  const key = solverRpcKey();
  const nonce = freshNonce();
  const worker = solverWorkerCommand();
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? request.parameters.maxTimeInSeconds * 1000 + graceMs;

  const frame = frameRequest(
    {
      protocolVersion: SOLVER_PROTOCOL_VERSION,
      messageType: 'SolveRequest',
      context: {
        organizationId: request.organizationId,
        groupId: request.groupId,
        buildRunId: request.buildRunId,
        correlationId: request.correlationId,
      },
      snapshotId: request.snapshotId,
      canonicalInputHash: request.canonicalInputHash,
      parameters: {
        randomSeed: request.parameters.randomSeed,
        numSearchWorkers: request.parameters.numSearchWorkers,
        maxTimeInSeconds: request.parameters.maxTimeInSeconds,
        maxDeterministicTime: request.parameters.maxDeterministicTime,
        interleaveSearch: request.parameters.interleaveSearch,
      },
      control: {
        cancelChannel: options.cancelFile === undefined ? 'none' : 'file',
        cancelFile: options.cancelFile ?? null,
        readyFile: options.readyFile ?? null,
        stubBehaviour: options.stubBehaviour ?? 'candidate',
        stubDwellMs: options.stubDwellMs ?? 0,
      },
      snapshot: request.snapshotPayload,
    },
    key,
    nonce,
  );

  const started = Date.now();
  /* `frame.wire` is signed and sent — the SAME bytes. The previous version
   * signed `canonicalStringify(wire)` and sent `JSON.stringify(wire)`, so the
   * MAC covered a rendering that never travelled; it agreed only for pure ASCII
   * and rejected every honest request carrying an accent, a CJK character or an
   * en-dash. */
  const transcript = await runWorker(worker, frame.wire, timeoutMs, graceMs);
  const elapsedMs = Date.now() - started;

  /* Terminated: the worker wrote nothing, so there is nothing to believe and
   * nothing to verify. The parent attributes the outcome, and it attributes the
   * TRUE one. SPEC-04 §2: state `failed`, reason `killed`. */
  if (transcript.kind === 'terminated') {
    return {
      status: 'FAILED',
      /* `killed` means THIS PROCESS terminated it — a signal, and nothing else.
       * A worker that never started, or that exited on its own without writing a
       * response, CRASHED; SPEC-04 §2 has a word for each and they are different
       * operational events (investigate the worker vs. investigate why we killed
       * it). Reporting all three as `killed` was a false attribution: the parent
       * claimed an action it had not taken. */
      terminationReason: transcript.reason,
      canonicalInputHash: request.canonicalInputHash,
      assignments: null,
      runtime: unknownRuntime(request),
      elapsedMs,
    };
  }
  if (transcript.kind === 'oversized') {
    throw new SolverResponseRejectedError({
      reason: 'oversized',
      bytes: transcript.bytes,
      limit: MAX_SOLVER_RESPONSE_BYTES,
    });
  }

  const responseFrame = splitFrame(transcript.stdout);
  if (responseFrame === null) throw new SolverResponseRejectedError({ reason: 'malformed' });

  /* Authenticated over the body BYTES AS RECEIVED, before the body is parsed. */
  const authenticated = verifyResponseFrame(responseFrame, key, nonce);

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseFrame.body.toString('utf8')) as unknown;
  } catch {
    /* The parse error's text quotes the input. It is discarded, not forwarded:
     * the input here is the worker's rendering of a whole group's schedule. */
    throw new SolverResponseRejectedError({ reason: 'malformed' });
  }

  const verdict = solverResponseVerdict({
    parsed,
    bytes: responseFrame.body.byteLength,
    expectedInputHash: request.canonicalInputHash,
    authenticated,
  });
  if (verdict.outcome === 'refused') throw new SolverResponseRejectedError(verdict.refusal);

  const body = parsed as Record<string, unknown>;
  return {
    status: verdict.status,
    terminationReason: verdict.terminationReason,
    canonicalInputHash: request.canonicalInputHash,
    assignments: readAssignments(body['assignments']),
    runtime: readRuntime(body['runtime'], request),
    elapsedMs,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Everything below is module-private. It is not exported, and that is a
 * structural choice rather than a stylistic one: every EXPORT of a provider
 * module must open with the boundary guard, so a helper that cannot sensibly
 * assert the boundary must not be an export. The alternative — carving an
 * exemption into the gate — would make the gate's rule conditional, and a
 * conditional gate is one whose conditions grow.
 * ──────────────────────────────────────────────────────────────────────────── */

type WorkerTranscript =
  | { readonly kind: 'response'; readonly stdout: Buffer; readonly bytes: number }
  /** `killed` only when a signal ended it; otherwise the worker died on its own. */
  | { readonly kind: 'terminated'; readonly reason: 'killed' | 'crashed'; readonly detail: string }
  | { readonly kind: 'oversized'; readonly bytes: number };

/**
 * Spawn, write, read, and enforce the deadline.
 *
 * `detached: false` and an explicit kill of the child is deliberate: the child
 * stays in this process's group so that a parent crash does not leave a solve
 * running with nobody to reap it, which is the orphan case the packet asks to be
 * proven absent.
 */
async function runWorker(
  worker: { command: string; args: readonly string[]; cwd: string },
  payload: Buffer,
  timeoutMs: number,
  graceMs: number,
): Promise<WorkerTranscript> {
  return new Promise<WorkerTranscript>((resolve) => {
    const child = spawn(worker.command, [...worker.args], {
      cwd: worker.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      /* The worker's own environment carries the shared secret and the image
       * digest, and NOTHING else this process holds. Passing the API's whole
       * environment would hand a compromised worker every database password in
       * it — the exact reach SPEC-04 §1.1 exists to remove, arriving through the
       * back door while the protocol stayed clean. */
      env: workerEnvironment(),
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (result: WorkerTranscript): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_SOLVER_RESPONSE_BYTES) {
        /* An untrusted child that streams without end would exhaust the API's
         * memory if the parent read to EOF. Stop reading, terminate, refuse. */
        child.kill('SIGKILL');
        settle({ kind: 'oversized', bytes });
        return;
      }
      chunks.push(chunk);
    });
    /* stderr is the worker's structured event stream. It is drained so the pipe
     * cannot fill and deadlock the child, and it is NOT accumulated: nothing on
     * it is needed to decide anything, and holding it would be holding a log of
     * a solve in memory for no purpose. */
    child.stderr.resume();

    const deadline = setTimeout(() => {
      /* Layer 3. SIGTERM first so a worker that can still respond exits
       * cleanly, then SIGKILL after the grace — the two-step SPEC-04 §2
       * describes, rather than an immediate kill that would deny a healthy
       * worker the chance to finish flushing. */
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    }, timeoutMs);

    child.on('error', () => {
      /* The interpreter never started. Nothing was killed — reporting `killed`
       * here would claim this process terminated something that never ran. */
      settle({ kind: 'terminated', reason: 'crashed', detail: 'spawn-failed' });
    });

    child.on('close', (code, signal) => {
      if (signal !== null) {
        /* A signal ended it, and this module is the only thing that sends one.
         * THIS is a kill. */
        settle({ kind: 'terminated', reason: 'killed', detail: signal });
        return;
      }
      if (bytes === 0) {
        /* Exited on its own without writing. Not a protocol refusal — the worker
         * always writes one, even for a refusal — so it crashed. */
        settle({
          kind: 'terminated',
          reason: 'crashed',
          detail: `exit-${String(code)}-no-response`,
        });
        return;
      }
      settle({ kind: 'response', stdout: Buffer.concat(chunks), bytes });
    });

    child.stdin.on('error', () => {
      /* A child that died before reading its input. `close` settles the result;
       * this handler exists so the EPIPE does not become an unhandled error. */
    });
    child.stdin.end(payload);
  });
}

/**
 * The environment one worker subprocess receives.
 *
 * An allowlist, not a filter. `process.env` for this API holds five database
 * role passwords and a superuser password; handing them to a second-language
 * subprocess would give a compromised worker exactly the tenant reach that
 * SPEC-04 §1.1 designs it not to have — through the environment rather than
 * through the protocol, while every document still said "the worker holds no
 * database credential".
 *
 * `PATH` is present because the interpreter needs it; `HOME` is deliberately
 * absent, and the spike measured why it is a real trade (EV-M0-SPC §3: a
 * sanitised `HOME` costs ~430 ms of `import ortools` on macOS). Correctness of
 * the boundary wins; the cost is a recorded, measured operational fact rather
 * than a surprise.
 */
function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const name of ['SP_SOLVER_RPC_SECRET', 'SP_SOLVER_RPC_KEY_ID', 'SP_SOLVER_IMAGE_DIGEST']) {
    const value = process.env[name];
    if (value !== undefined && value !== '') allowed[name] = value;
  }
  return allowed;
}

/** The runtime record when the worker never got to produce one. */
function unknownRuntime(request: SolveRequestSpec): SolverRuntimeRecord {
  return {
    imageDigest: 'unknown',
    solverVersion: 'unknown',
    compilerVersion: 'unknown',
    platformArch: 'unknown',
    languageRuntime: 'unknown',
    /* Computed from the parameters that WERE dispatched. A killed run is still
     * re-runnable from the same pinned snapshot and the same parameters
     * (SPEC-04 §2, "Re-runnable"), so the mode is a fact about the request and
     * not about whether this attempt survived. */
    reproducibilityMode: reproducibilityMode(request.parameters),
  };
}

function readAssignments(value: unknown): readonly SolverCandidateAssignment[] | null {
  if (!Array.isArray(value)) return null;
  const assignments: SolverCandidateAssignment[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const membershipId = row['membershipId'];
    const date = row['date'];
    const shiftTypeId = row['shiftTypeId'];
    const locationId = row['locationId'];
    if (typeof membershipId !== 'string') continue;
    if (typeof date !== 'string') continue;
    if (typeof shiftTypeId !== 'string') continue;
    assignments.push({
      membershipId,
      date,
      shiftTypeId,
      locationId: typeof locationId === 'string' ? locationId : null,
    });
  }
  return assignments;
}

/**
 * The reproducibility record, read defensively.
 *
 * `reproducibilityMode` is **recomputed here from the parameters this process
 * dispatched**, not taken from the worker. The whole point of the SPEC-04 §4
 * amendment is that reproducibility is a computed property of the conditions,
 * and a worker that claimed `deterministic` while running a wall-clock deadline
 * would be making exactly the claim the measurement disproved.
 */
function readRuntime(value: unknown, request: SolveRequestSpec): SolverRuntimeRecord {
  const row =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const text = (name: string): string => {
    const raw = row[name];
    return typeof raw === 'string' && raw !== '' ? raw : 'unknown';
  };
  return {
    imageDigest: text('imageDigest'),
    solverVersion: text('solverVersion'),
    compilerVersion: text('compilerVersion'),
    platformArch: text('platformArch'),
    languageRuntime: text('languageRuntime'),
    reproducibilityMode: reproducibilityMode(request.parameters),
  };
}
