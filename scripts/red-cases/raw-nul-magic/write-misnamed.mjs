#!/usr/bin/env node
/**
 * Writes the magic-byte arm's violation: a TEXT file wearing a `.png` name and
 * carrying a raw `U+0000`.
 *
 * Written at run time rather than committed, because the gate under test scans
 * `git ls-files` — a committed fixture carrying a raw NUL would fail the gate on
 * every ordinary run. That is the same trap the `raw-nul-scan` arm's own note
 * describes: "a red case that had to carry the defect it tests would be caught
 * by the gate it is testing".
 *
 * The NUL is spelled `\u0000` here so THIS file stays clean.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const target = resolve(HERE, 'fixture/__red_case__misnamed.png');
mkdirSync(dirname(target), { recursive: true });

/* NOT a PNG: no `\x89PNG\r\n\x1a\n` prefix. That is the whole point — before the
 * magic-byte hardening this file was skipped on its extension alone, and the
 * reviewer measured that bypass. */
writeFileSync(target, `notes, not an image, and a raw\u0000NUL nobody can see\n`, 'utf8');
process.stdout.write(`wrote ${target}\n`);
