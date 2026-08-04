import {
  acknowledgementSchema,
  mfaEnrolmentConfirmResultSchema,
  mfaEnrolmentStartResultSchema,
  signInResultSchema,
  type MfaEnrolmentConfirmResult,
  type MfaEnrolmentStartResult,
  type SignInResult,
} from '@schedulepoint/contracts';

import { apiRequest } from '../api/client.js';

/**
 * The authentication client.
 *
 * ## One user action, one request (I-10)
 *
 * Every function here is exactly one `fetch`. There is no "check the address
 * exists, then sign in", no optimistic pre-flight and no retry: a second request
 * per action is the amplification I-10 forbids, and the request-budget gate
 * measures it from a real recording rather than from this comment.
 *
 * ## Nothing is stored client-side
 *
 * The session lives in an `HttpOnly` cookie the browser sends and this code
 * cannot read. There is deliberately no `localStorage`, no `sessionStorage` and
 * no in-memory token: a token JavaScript can read is a token an injected script
 * can exfiltrate, and `HttpOnly` is the control (14 §3, T-07).
 *
 * The enrolment secret and the recovery codes ARE returned to the client, once,
 * because they have to be shown. They are held in React state for the life of
 * the page and are never persisted.
 */

function organizationPath(organizationId: string, suffix: string): string {
  return `/organizations/${organizationId}/authn${suffix}`;
}

export async function signIn(
  organizationId: string,
  body: { loginEmail: string; password: string; persistent?: boolean },
): Promise<SignInResult> {
  const result = await apiRequest(organizationPath(organizationId, '/sign-in'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return signInResultSchema.parse(result);
}

export async function signOut(organizationId: string): Promise<void> {
  await apiRequest(organizationPath(organizationId, '/sign-out'), { method: 'POST' });
}

export async function startMfaEnrolment(
  organizationId: string,
): Promise<MfaEnrolmentStartResult> {
  const result = await apiRequest(organizationPath(organizationId, '/mfa/enrolment'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  return mfaEnrolmentStartResultSchema.parse(result);
}

export async function confirmMfaEnrolment(
  organizationId: string,
  code: string,
): Promise<MfaEnrolmentConfirmResult> {
  const result = await apiRequest(organizationPath(organizationId, '/mfa/enrolment/confirmation'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return mfaEnrolmentConfirmResultSchema.parse(result);
}

export async function challengeMfa(
  organizationId: string,
  body: { code?: string; recoveryCode?: string },
): Promise<SignInResult> {
  const result = await apiRequest(organizationPath(organizationId, '/mfa/challenge'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return signInResultSchema.parse(result);
}

export async function activateAccount(
  organizationId: string,
  body: { token: string; password: string },
): Promise<void> {
  const result = await apiRequest(organizationPath(organizationId, '/activation'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  acknowledgementSchema.parse(result);
}

export async function requestPasswordReset(
  organizationId: string,
  loginEmail: string,
): Promise<void> {
  const result = await apiRequest(organizationPath(organizationId, '/password-reset'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginEmail }),
  });
  acknowledgementSchema.parse(result);
}

export async function completePasswordReset(
  organizationId: string,
  body: { token: string; password: string },
): Promise<void> {
  const result = await apiRequest(
    organizationPath(organizationId, '/password-reset/completion'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  acknowledgementSchema.parse(result);
}
