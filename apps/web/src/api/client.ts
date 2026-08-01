import {
  errorEnvelopeSchema,
  healthStatusSchema,
  type HealthStatus,
} from '@schedulepoint/contracts';

/**
 * The API client.
 *
 * Two rules the network-assertion guard enforces mechanically, stated here so
 * the reason is visible at the call site:
 *
 *  1. **Every URL is same-origin and relative.** CAP-068 / T-23: the browser
 *     never talks to a third-party host. Not analytics, not a font CDN, not an
 *     error reporter. A gate fails the build on any absolute external URL in
 *     `apps/web`, and the allowlist is empty.
 *  2. **Every response is parsed through the shared zod contract.** An
 *     unparsed response is an untyped response no matter what the TypeScript
 *     signature claims.
 */

/** Same-origin API prefix. The reverse proxy (ingress image) routes it to the API. */
const API_PREFIX = '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly correlationId: string | undefined;

  constructor(code: string, message: string, correlationId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
    credentials: 'same-origin',
  });

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    if (envelope.success) {
      throw new ApiError(
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.correlationId,
      );
    }
    throw new ApiError('UNEXPECTED_RESPONSE', `Request failed (${String(response.status)}).`);
  }

  return body;
}

export async function fetchHealth(): Promise<HealthStatus> {
  return healthStatusSchema.parse(await request('/health'));
}
