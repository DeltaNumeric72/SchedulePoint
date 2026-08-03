import { ProcessAlertSink } from '../db/alerts.js';
import { createPool } from '../db/pool.js';
import { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import { createCheckpointSigner } from './checkpoint-signer.js';
import { verifyAuditChain, verifyCheckpoints } from './verification.js';

/**
 * `tsx src/audit/verify-cli.ts <organization-id> [--json]`
 *
 * The chain-verification command — SPEC-11 §2's "verification job", runnable by
 * hand. It is what an operator runs **after every migration and after every
 * restore** (SPEC-11 §3), and what the periodic job will call.
 *
 * ## Exit codes, because a verification tool's exit code is its whole interface
 *
 * | Code | Meaning |
 * |---|---|
 * | `0` | the chain is intact **and** every checkpoint verifies and matches |
 * | `1` | a chain problem, a checkpoint mismatch, or an unverifiable signature |
 * | `2` | the tool could not answer — bad arguments, no database |
 *
 * `1` and `2` are deliberately different. "The chain is broken" and "I could not
 * check" must never look the same to a monitor, and a tool that exits `1` on a
 * connection error trains its operator to ignore `1`.
 *
 * ## Two answers, not one
 *
 * `chain` asks whether the rows are self-consistent; `checkpoints` asks whether
 * the chain still says what was signed. A consistently rewritten segment passes
 * the first and fails the second (SPEC-11 X-02), so collapsing them would hide
 * the only tampering a competent actor produces.
 *
 * **The checkpoint half is only as good as the signer.** This process builds a
 * `LocalCheckpointSigner`, whose key it holds — `keyIsIsolated === false`. The
 * output says so, every run, because a signature verified by a key the verifier
 * could also have used to sign is not evidence of anything.
 */

interface Args {
  readonly organizationId: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args | undefined {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const organizationId = positional[0];
  if (
    organizationId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)
  ) {
    return undefined;
  }
  return { organizationId, json: argv.includes('--json') };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    process.stderr.write(
      'usage: tsx src/audit/verify-cli.ts <organization-id> [--json]\n' +
        '  verifies one organization\'s audit chain and its signed checkpoints\n' +
        '  exit 0 = intact · 1 = a problem was found · 2 = could not check\n',
    );
    return 2;
  }

  const pool = createPool('app_readonly_support', { max: 2, allowExitOnIdle: true });
  const runner = new PgUnitOfWorkRunner({
    role: 'app_readonly_support',
    pool,
    alerts: new ProcessAlertSink(),
  });
  const signer = createCheckpointSigner();

  try {
    // Organization-scoped: the chain is per organization and a group-scoped read
    // would see a subset. `verifyAuditChain` refuses the wrong scope outright.
    const context = {
      organizationId: args.organizationId,
      groupId: null,
      membershipId: null,
      correlationId: 'audit-verify-cli',
    };

    const chain = await runner.run(context, (uow) => verifyAuditChain(uow));
    const checkpoints = await runner.run(context, (uow) =>
      verifyCheckpoints(uow, (m, s) => signer.verify(m, s)),
    );

    const badCheckpoints = checkpoints.filter((c) => !c.signatureValid || !c.matchesChain);
    const ok = chain.intact && badCheckpoints.length === 0;

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok, keyIsIsolated: signer.keyIsIsolated, chain, checkpoints }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`organization : ${args.organizationId}\n`);
      process.stdout.write(
        `chain        : ${chain.intact ? 'INTACT' : 'BROKEN'} — ` +
          `${String(chain.entries)} entries, head ${String(chain.headSequence ?? '(none)')}\n`,
      );
      for (const problem of chain.problems) {
        process.stdout.write(`  ! sequence ${problem.sequence}: ${problem.problem}\n`);
      }
      process.stdout.write(
        `checkpoints  : ${String(checkpoints.length)} signed, ` +
          `${String(badCheckpoints.length)} problem(s)\n`,
      );
      for (const c of badCheckpoints) {
        process.stdout.write(
          `  ! sequence ${c.sequence}: signatureValid=${String(c.signatureValid)} ` +
            `matchesChain=${String(c.matchesChain)}\n`,
        );
      }
      if (!signer.keyIsIsolated) {
        process.stdout.write(
          'NOTE         : the signing key is held by THIS PROCESS (local stub, FAD-7).\n' +
            '               A checkpoint verified here proves the signing path works and\n' +
            '               NOTHING about who could have produced it. SPEC-11 §6 requires a\n' +
            '               separate trust domain; real KMS is a deployment condition (TDG-15).\n',
        );
      }
      process.stdout.write(`result       : ${ok ? 'OK' : 'PROBLEMS FOUND'}\n`);
    }

    return ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `could not verify: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
