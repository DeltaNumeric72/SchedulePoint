/**
 * RED CASE — production build.
 *
 * An unresolvable import. `vite build` must fail rather than emit a bundle with
 * a missing module.
 */
import { missing } from './this-module-does-not-exist.js';

export const value = missing;
