import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import {
  HANDSHAKE_PATH,
  REAL_STACK_API_PORT,
  REAL_STACK_ORIGIN,
  REAL_STACK_PG_PORT,
  REAL_STACK_PORT,
  REPO_ROOT,
  WEB_DIST,
} from './real-stack.js';

/**
 * Playwright `globalSetup` for the REAL stack (FAD-48 clause (A) part 3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Three things start here and nothing is intercepted anywhere:
 *
 *  1. **the daemon** — `apps/api/test/support/real-stack-daemon.ts`, spawned as a
 *     PROCESS rather than imported. That is deliberate: `apps/web` may import
 *     `packages/contracts` and nothing else (`.dependency-cruiser.cjs`), and an
 *     e2e harness is not an exemption from the boundary it is supposed to be
 *     testing across. The two sides talk over a pipe;
 *  2. **the origin** — a static server for `apps/web/dist` that proxies `/api/**`
 *     to the API. The browser therefore sees ONE origin, exactly as the ingress
 *     image gives it in a deployment, and the client's same-origin
 *     `credentials: 'same-origin'` cookie works for the same reason it does
 *     there;
 *  3. **nothing else.** No `page.route`, no fulfilled JSON, no fixture server.
 *
 * ## Why a hand-written origin rather than `vite preview`
 *
 * `vite preview` serves the bundle but proxies nothing, and adding a proxy means
 * editing `apps/web/vite.config.ts` — which is not in this packet's allowed
 * files, and which would change what the AXE gate serves. Forty lines of
 * `node:http` here changes nothing outside the real-stack run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DAEMON = resolve(REPO_ROOT, 'apps/api/test/support/real-stack-daemon.ts');
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const READY_TIMEOUT_MS = 240_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

let daemon: ChildProcess | undefined;
let origin: Server | undefined;

function startOrigin(apiPort: number): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    const url = incoming.url ?? '/';

    /* ── the API, proxied verbatim ───────────────────────────────────────────
     *
     * Headers, method, body and status all pass through untouched — including
     * `set-cookie`, without which the session the browser is issued would never
     * reach it, and `x-schedulepoint-context`, which is the whole point of the
     * run. Nothing is rewritten: a proxy that edited a header would be a place
     * for the join to be faked. */
    if (url.startsWith('/api/')) {
      const proxied = httpRequest(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: url.slice('/api'.length),
          method: incoming.method,
          headers: { ...incoming.headers, host: `127.0.0.1:${String(apiPort)}` },
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      proxied.on('error', () => {
        outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"","correlationId":"-"}}');
      });
      incoming.pipe(proxied);
      return;
    }

    /* ── the bundle, with an SPA fallback ─────────────────────────────────── */
    const withoutQuery = url.split('?')[0] ?? '/';
    const candidate = join(WEB_DIST, normalize(withoutQuery));
    const file =
      candidate.startsWith(WEB_DIST) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(WEB_DIST, 'index.html');
    outgoing.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(outgoing);
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(REAL_STACK_PORT, '127.0.0.1', () => {
      done(server);
    });
  });
}

function startDaemon(): Promise<void> {
  mkdirSync(resolve(HANDSHAKE_PATH, '..'), { recursive: true });

  daemon = spawn(process.execPath, [TSX_CLI, DAEMON], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SP_TEST_PG_PORT: String(REAL_STACK_PG_PORT),
      SP_REAL_STACK_API_PORT: String(REAL_STACK_API_PORT),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      fail(
        new Error(
          `the real-stack daemon did not report READY within ${String(READY_TIMEOUT_MS)}ms`,
        ),
      );
    }, READY_TIMEOUT_MS);

    let buffer = '';
    daemon?.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((candidate) => candidate.startsWith('REALSTACK '));
      if (line === undefined) return;
      clearTimeout(timer);
      writeFileSync(HANDSHAKE_PATH, `${line.slice('REALSTACK '.length)}\n`, 'utf8');
      done();
    });
    daemon?.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`the real-stack daemon exited with ${String(code)} before reporting READY`));
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(
      `apps/web/dist/index.html is missing — run \`corepack pnpm gate:build\` first. The ` +
        `real-stack run serves the PRODUCTION bundle, never the dev server.`,
    );
  }

  await startDaemon();
  origin = await startOrigin(REAL_STACK_API_PORT);

  /* ── the handshake, SET rather than assumed (FAD-50 C-3) ──────────────────
   *
   * `realStackAvailable()` reads `SP_REAL_STACK`, and until now **nothing set
   * it**. This setup passed `SP_REAL_STACK_API_PORT` to the daemon's env and
   * stopped there, so `critical-path.spec.ts` guarded itself on a variable that
   * was absent even under this config: the marquee real-stack suite exited 0
   * with `2 skipped`, and two docblocks said otherwise.
   *
   * Set HERE, at the point the stack demonstrably exists — after the daemon has
   * reported READY and the origin is listening — so the flag means "the stack
   * is up", which is what every reader already believed it meant. Setting it in
   * the config file or the shell would only mean "somebody intended it to be".
   *
   * The environment is inherited by the worker processes Playwright forks, which
   * is what makes one assignment here reach the spec. `must-run-reporter.ts` is
   * the belt for the braces: if this ever stops working, the run FAILS rather
   * than passing with nothing executed. */
  process.env['SP_REAL_STACK'] = '1';
  process.stdout.write(
    `real stack ready: origin ${REAL_STACK_ORIGIN} -> api 127.0.0.1:${String(REAL_STACK_API_PORT)} ` +
      `-> postgres 127.0.0.1:${String(REAL_STACK_PG_PORT)}\n`,
  );

  return async (): Promise<void> => {
    await new Promise<void>((done) => {
      if (origin === undefined) {
        done();
        return;
      }
      origin.close(() => {
        done();
      });
      origin.closeAllConnections?.();
    });
    if (daemon !== undefined && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          daemon?.kill('SIGKILL');
          done();
        }, 30_000);
        daemon?.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  };
}
