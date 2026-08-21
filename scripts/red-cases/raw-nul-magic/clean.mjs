#!/usr/bin/env node
/** Removes the magic-byte arm's violation file. See `write-misnamed.mjs`. */
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(HERE, 'fixture/__red_case__misnamed.png'), { force: true });
process.stdout.write('cleaned the magic-byte fixture\n');
