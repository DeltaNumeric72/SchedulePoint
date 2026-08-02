import { migrate, migrateCycle } from '../db/migrate.js';

/**
 * `pnpm --filter @schedulepoint/api migrate:{up,down,cycle}`.
 *
 * A thin CLI over `src/db/migrate.ts`. It exists so the migration cycle is a
 * command a reviewer can run and capture, rather than something only the test
 * harness ever executes.
 */

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  switch (command) {
    case 'up': {
      const result = await migrate('up', { log });
      log(`up: ${result.applied.length === 0 ? '(nothing to apply)' : result.applied.join(', ')}`);
      return;
    }
    case 'down': {
      const result = await migrate('down', { count: Infinity, log });
      log(`down: ${result.applied.length === 0 ? '(nothing to revert)' : result.applied.join(', ')}`);
      return;
    }
    case 'cycle': {
      const result = await migrateCycle(log);
      log(`up   : ${result.up1.join(', ')}`);
      log(`down : ${result.down.join(', ')}`);
      log(`up   : ${result.up2.join(', ')}`);
      log('migration cycle clean: up -> down -> up');
      return;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(command)} (expected up | down | cycle)`);
  }
}

await main();
