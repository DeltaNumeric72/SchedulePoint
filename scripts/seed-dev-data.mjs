/**
 * Development seed — **placeholder**.
 *
 * There is no schema yet, so there is nothing to seed. This file exists to fix
 * two things before any data exists, because both are hard to add back later:
 *
 *  1. **Where seeding lives**, so it does not end up inside a migration. A
 *     migration that seeds is a migration that cannot be run twice and cannot be
 *     run in production.
 *  2. **What may be seeded.** Synthetic data only — no real staff, patient, or
 *     customer data, and no organization, site, or person name drawn from the
 *     research corpus (the clean-room boundary). The generator below is the only
 *     permitted source of names, and it is deliberately obviously fake.
 */

/** Obviously-synthetic name parts. Nothing here resembles a real person. */
const SYNTHETIC_GIVEN = ['Ash', 'Bryn', 'Cleo', 'Dax', 'Ellis', 'Fen'];
const SYNTHETIC_FAMILY = ['Aster', 'Birch', 'Cedar', 'Dahlia', 'Elm', 'Fern'];

/**
 * Deterministic synthetic person name.
 *
 * @param {number} index
 * @returns {string}
 */
export function syntheticPersonName(index) {
  const given = SYNTHETIC_GIVEN[index % SYNTHETIC_GIVEN.length] ?? 'Ash';
  const family =
    SYNTHETIC_FAMILY[Math.floor(index / SYNTHETIC_GIVEN.length) % SYNTHETIC_FAMILY.length] ??
    'Aster';
  return `${given} ${family}-${String(index).padStart(3, '0')}`;
}

function main() {
  process.stdout.write(
    [
      'seed-dev-data: nothing to seed.',
      '',
      'No schema exists yet (OPUS-M0-002 ships no migrations). When it does, seeding',
      'happens here and nowhere else — never inside a migration — and uses synthetic',
      'data only.',
      '',
      `Example synthetic name: ${syntheticPersonName(7)}`,
      '',
    ].join('\n'),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
