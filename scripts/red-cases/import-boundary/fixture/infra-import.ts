/**
 * RED CASE — import boundary.
 *
 * A domain module reaching into the application layer. This is the direction
 * document 04's layering forbids, and it is the one that looks most reasonable
 * at the call site — "I only need the type". The dependency-cruiser rule
 * `domain-imports-nothing` must reject it.
 */
import type { BuiltServer } from '../../../apps/api/src/http/server.js';

export type LeakedServerType = BuiltServer;
