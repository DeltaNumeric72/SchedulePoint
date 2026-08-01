/**
 * Import-boundary gate — document 04 (domain boundaries), TDG-01 replacement
 * boundary ("handlers are thin adapters; domain has no framework imports").
 *
 * The layering, innermost first:
 *
 *   packages/domain     imports NOTHING — no framework, no driver, no node
 *                       builtin, no sibling package. Everything it needs from
 *                       the outside arrives as a port it declares itself.
 *   packages/contracts  imports zod and nothing else.
 *   apps/api            may import domain and contracts.
 *   apps/web            may import contracts. Never the API's source.
 *
 * The direction is the whole point: a domain that can reach infrastructure will
 * eventually reach it, and the reach is invisible in review because each
 * individual import looks reasonable.
 *
 * Proof that this configuration actually blocks a violation:
 * `scripts/red-cases/import-boundary/`, run by `pnpm red-cases`.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-imports-nothing',
      severity: 'error',
      comment:
        'packages/domain is the innermost layer. It imports nothing outside itself — not apps/**, not another workspace package, not a framework, not a node builtin.',
      from: { path: '^packages/domain/src' },
      to: { pathNot: '^packages/domain/src' },
    },
    {
      name: 'contracts-imports-only-zod',
      severity: 'error',
      comment:
        'packages/contracts is the shared leaf. Its only dependency is the validation library.',
      from: { path: '^packages/contracts/src' },
      to: {
        pathNot: ['^packages/contracts/src', 'node_modules/zod'],
      },
    },
    {
      name: 'web-never-imports-api-source',
      severity: 'error',
      comment:
        'The browser bundle must not reach into server source. The contract package is the only shared surface.',
      from: { path: '^apps/web' },
      to: { path: '^apps/api' },
    },
    {
      name: 'api-never-imports-web',
      severity: 'error',
      comment: 'The server does not depend on the client bundle.',
      from: { path: '^apps/api' },
      to: { path: '^apps/web' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle makes the layering unenforceable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'An unresolvable import means the graph is incomplete, which means the boundary rules above are checking less than they appear to.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: [
        'node_modules',
        '(^|/)dist/',
        '(^|/)dist-types/',
        '(^|/)test/',
        '(^|/)e2e/',
        '\\.config\\.(ts|js|mjs|cjs)$',
      ],
    },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
