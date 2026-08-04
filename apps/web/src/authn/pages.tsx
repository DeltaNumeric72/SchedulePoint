import { MINIMUM_PASSWORD_LENGTH } from '@schedulepoint/contracts';
import { useParams } from '@tanstack/react-router';
import { useState, type JSX } from 'react';

import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { AuthnPage, AuthnStatus, useAuthnForm } from './AuthnLayout.js';
import * as authn from './api.js';

/**
 * The five authentication surfaces — SP-E brief §2's M1 list, landing here.
 *
 * | Page | Route |
 * |---|---|
 * | sign in | `/organizations/$organizationId/sign-in` |
 * | MFA challenge | `/organizations/$organizationId/sign-in/challenge` |
 * | MFA enrolment | `/organizations/$organizationId/sign-in/enrolment` |
 * | activation | `/organizations/$organizationId/activate` |
 * | password reset | `/organizations/$organizationId/reset` and `/reset/complete` |
 *
 * ## What every one of them does the same way, and why
 *
 * - **the organization is in the PATH.** SPEC-01 §2.2 requires the client to
 *   declare its tenant and §3 requires switching it to be explicit; a path
 *   carries that through a bookmark, a shared link and a second tab, where a
 *   session-global "current organization" is the CAR-001 defect class.
 * - **validation is submit-only.** Per-keystroke validation re-announces on every
 *   character (SPEC-14 AC-11); the summary appears once, takes focus, and links
 *   to the field.
 * - **nothing persists before an explicit submit** (I-13). No page performs a
 *   request on mount and no control writes on click.
 * - **the token never appears in a URL.** Activation and reset take their token
 *   in a form field, not in a path segment: a token in a URL lands in browser
 *   history, in a `Referer` header and in every proxy log between here and the
 *   server (14 §4's referrer policy exists for the same reason).
 * - **one action, one request** (I-10). The submit button is disabled while a
 *   request is in flight, and the client-side pre-check makes NO request when it
 *   fails.
 */

function useOrganizationId(): string {
  // The route declares the parameter, so this cannot be undefined at runtime;
  // the fallback exists so a mis-mounted page renders an empty form rather than
  // throwing inside a render.
  const params = useParams({ strict: false }) as { organizationId?: string };
  return params.organizationId ?? '';
}

function requiredProblem(field: string, value: string, label: string): FieldProblem | undefined {
  return value.trim().length === 0 ? { field, message: `${label} is required.` } : undefined;
}

function passwordProblem(field: string, value: string): FieldProblem | undefined {
  if (value.length === 0) return { field, message: 'A new password is required.' };
  if ([...value].length < MINIMUM_PASSWORD_LENGTH) {
    return {
      field,
      message: `A password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`,
    };
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sign in
 * ──────────────────────────────────────────────────────────────────────────── */

export function SignInPage(): JSX.Element {
  const organizationId = useOrganizationId();
  const form = useAuthnForm();
  const ids = useFieldIds('sign-in', ['loginEmail', 'password', 'persistent']);
  const [loginEmail, setLoginEmail] = useState('');
  const [password, setPassword] = useState('');
  const [persistent, setPersistent] = useState(false);

  const problemFor = (field: string): string | undefined =>
    form.problems.find((problem) => problem.field === field)?.message;

  return (
    <AuthnPage
      title="Sign in"
      intro="Enter the email address your organization invited, and your password."
    >
      <AuthnStatus
        state={form.state}
        problems={form.problems}
        fieldIds={ids}
        formName="sign-in"
      />
      <form
        className="flex flex-col gap-sp-4"
        data-testid="sign-in-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(
            () =>
              [
                requiredProblem('loginEmail', loginEmail, 'A login email'),
                requiredProblem('password', password, 'A password'),
              ].filter((problem): problem is FieldProblem => problem !== undefined),
            async () => {
              const result = await authn.signIn(organizationId, {
                loginEmail,
                password,
                persistent,
              });
              return result.state === 'authenticated'
                ? 'Signed in.'
                : result.state === 'mfa_required'
                  ? 'Enter the code from your authenticator app.'
                  : 'Set up an authenticator app to finish signing in.';
            },
          );
        }}
      >
        <Field id={ids.loginEmail} label="Login email">
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="username"
              type="email"
              value={loginEmail}
              onChange={(event) => {
                setLoginEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          id={ids.password}
          label="Password"
          problem={problemFor('password')}
        >
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="flex items-center gap-sp-2">
          <input
            checked={persistent}
            className="min-h-target min-w-target"
            id={ids.persistent}
            type="checkbox"
            onChange={(event) => {
              setPersistent(event.target.checked);
            }}
          />
          <label className="text-text" htmlFor={ids.persistent}>
            Stay signed in on this device
          </label>
        </div>
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="sign-in-submit"
          disabled={form.state.kind === 'submitting'}
          type="submit"
        >
          Sign in
        </button>
      </form>
      <p className="mt-sp-4 text-sm">
        <a className="text-accent underline" href={`/organizations/${organizationId}/reset`}>
          Forgotten your password?
        </a>
      </p>
    </AuthnPage>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * MFA challenge
 * ──────────────────────────────────────────────────────────────────────────── */

export function MfaChallengePage(): JSX.Element {
  const organizationId = useOrganizationId();
  const form = useAuthnForm();
  const ids = useFieldIds('mfa-challenge', ['code', 'recoveryCode']);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  return (
    <AuthnPage
      title="Two-step verification"
      intro="Enter the six-digit code from your authenticator app."
    >
      <AuthnStatus
        state={form.state}
        problems={form.problems}
        fieldIds={ids}
        formName="mfa-challenge"
      />
      <form
        className="flex flex-col gap-sp-4"
        data-testid="mfa-challenge-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(
            () =>
              useRecovery
                ? [requiredProblem('recoveryCode', recoveryCode, 'A recovery code')].filter(
                    (problem): problem is FieldProblem => problem !== undefined,
                  )
                : [requiredProblem('code', code, 'A code')].filter(
                    (problem): problem is FieldProblem => problem !== undefined,
                  ),
            async () => {
              await authn.challengeMfa(
                organizationId,
                useRecovery ? { recoveryCode } : { code },
              );
              return 'Signed in.';
            },
          );
        }}
      >
        {useRecovery ? (
          <Field
            id={ids.recoveryCode}
            label="Recovery code"
            help="One of the codes you saved when you set up two-step verification. Each works once."
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                autoComplete="one-time-code"
                type="text"
                value={recoveryCode}
                onChange={(event) => {
                  setRecoveryCode(event.target.value);
                }}
              />
            )}
          </Field>
        ) : (
          <Field
            id={ids.code}
            label="Authentication code"
            help="Six digits, from your authenticator app."
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                autoComplete="one-time-code"
                inputMode="numeric"
                type="text"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            )}
          </Field>
        )}
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="mfa-challenge-submit"
          disabled={form.state.kind === 'submitting'}
          type="submit"
        >
          Verify
        </button>
      </form>
      <button
        className="mt-sp-4 min-h-target text-accent underline"
        data-testid="mfa-use-recovery"
        type="button"
        onClick={() => {
          // A view toggle, and nothing else: it writes no state anywhere and
          // makes no request (I-13).
          setUseRecovery((previous) => !previous);
          form.reset();
        }}
      >
        {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
      </button>
    </AuthnPage>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * MFA enrolment
 * ──────────────────────────────────────────────────────────────────────────── */

export function MfaEnrolmentPage(): JSX.Element {
  const organizationId = useOrganizationId();
  const start = useAuthnForm();
  const confirm = useAuthnForm();
  const ids = useFieldIds('mfa-enrolment', ['code']);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [code, setCode] = useState('');

  return (
    <AuthnPage
      title="Set up two-step verification"
      intro="Your role requires a second factor. Add SchedulePoint to an authenticator app, then confirm with a code."
    >
      <AuthnStatus state={start.state} problems={[]} fieldIds={ids} formName="mfa-start" />
      {secret === undefined ? (
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="mfa-enrolment-start"
          disabled={start.state.kind === 'submitting'}
          type="button"
          onClick={() => {
            void start.submit(
              () => [],
              async () => {
                const result = await authn.startMfaEnrolment(organizationId);
                setSecret(result.secretBase32);
                return 'A setup key is ready. Add it to your authenticator app.';
              },
            );
          }}
        >
          Get a setup key
        </button>
      ) : (
        <>
          <div className="mb-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4">
            <p className="font-medium">Setup key</p>
            {/* Shown ONCE and never persisted client-side. There is no endpoint
                that reads it back, so a user who navigates away starts again. */}
            <p className="mt-sp-2 break-all font-mono" data-testid="mfa-secret">
              {secret}
            </p>
          </div>
          <AuthnStatus
            state={confirm.state}
            problems={confirm.problems}
            fieldIds={ids}
            formName="mfa-enrolment"
          />
          <form
            className="flex flex-col gap-sp-4"
            data-testid="mfa-enrolment-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void confirm.submit(
                () =>
                  [requiredProblem('code', code, 'A code')].filter(
                    (problem): problem is FieldProblem => problem !== undefined,
                  ),
                async () => {
                  const result = await authn.confirmMfaEnrolment(organizationId, code);
                  setRecoveryCodes(result.recoveryCodes);
                  return 'Two-step verification is on. Save your recovery codes now.';
                },
              );
            }}
          >
            <Field
              id={ids.code}
              label="Authentication code"
              help="Six digits, from the app you just added the key to."
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  type="text"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                />
              )}
            </Field>
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="mfa-enrolment-submit"
              disabled={confirm.state.kind === 'submitting'}
              type="submit"
            >
              Confirm
            </button>
          </form>
        </>
      )}
      {recoveryCodes.length === 0 ? null : (
        <div className="mt-sp-5 rounded-panel border border-border bg-surface-raised p-sp-4">
          <h2 className="font-semibold">Recovery codes</h2>
          <p className="mt-sp-2 text-text-muted">
            Each code works once. They are shown now and never again.
          </p>
          <ul className="mt-sp-3 font-mono" data-testid="mfa-recovery-codes">
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode}>{recoveryCode}</li>
            ))}
          </ul>
        </div>
      )}
    </AuthnPage>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Activation
 * ──────────────────────────────────────────────────────────────────────────── */

export function ActivationPage(): JSX.Element {
  const organizationId = useOrganizationId();
  const form = useAuthnForm();
  const ids = useFieldIds('activation', ['token', 'password']);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');

  const problemFor = (field: string): string | undefined =>
    form.problems.find((problem) => problem.field === field)?.message;

  return (
    <AuthnPage
      title="Activate your account"
      intro="Paste the code from your invitation and choose a password."
    >
      <AuthnStatus
        state={form.state}
        problems={form.problems}
        fieldIds={ids}
        formName="activation"
      />
      <form
        className="flex flex-col gap-sp-4"
        data-testid="activation-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(
            () =>
              [
                requiredProblem('token', token, 'An invitation code'),
                passwordProblem('password', password),
              ].filter((problem): problem is FieldProblem => problem !== undefined),
            async () => {
              await authn.activateAccount(organizationId, { token, password });
              return 'Your account is active. You can sign in now.';
            },
          );
        }}
      >
        <Field
          id={ids.token}
          label="Invitation code"
          help="From the invitation you were sent. It works once and then expires."
          problem={problemFor('token')}
        >
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="off"
              type="text"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          id={ids.password}
          label="New password"
          help={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`}
          problem={problemFor('password')}
        >
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="new-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="activation-submit"
          disabled={form.state.kind === 'submitting'}
          type="submit"
        >
          Activate
        </button>
      </form>
    </AuthnPage>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Password reset
 * ──────────────────────────────────────────────────────────────────────────── */

export function PasswordResetRequestPage(): JSX.Element {
  const organizationId = useOrganizationId();
  const form = useAuthnForm();
  const ids = useFieldIds('reset-request', ['loginEmail']);
  const [loginEmail, setLoginEmail] = useState('');

  return (
    <AuthnPage
      title="Reset your password"
      intro="We will send a single-use link to the address on your account."
    >
      <AuthnStatus
        state={form.state}
        problems={form.problems}
        fieldIds={ids}
        formName="reset-request"
      />
      <form
        className="flex flex-col gap-sp-4"
        data-testid="reset-request-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(
            () =>
              [requiredProblem('loginEmail', loginEmail, 'A login email')].filter(
                (problem): problem is FieldProblem => problem !== undefined,
              ),
            async () => {
              await authn.requestPasswordReset(organizationId, loginEmail);
              // The SAME message whatever the server found. The endpoint does
              // not distinguish a known address from an unknown one, and the
              // interface must not undo that by being helpful.
              return 'If that address has an account, a reset link is on its way.';
            },
          );
        }}
      >
        <Field id={ids.loginEmail} label="Login email">
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="username"
              type="email"
              value={loginEmail}
              onChange={(event) => {
                setLoginEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="reset-request-submit"
          disabled={form.state.kind === 'submitting'}
          type="submit"
        >
          Send a reset link
        </button>
      </form>
    </AuthnPage>
  );
}

export function PasswordResetCompletePage(): JSX.Element {
  const organizationId = useOrganizationId();
  const form = useAuthnForm();
  const ids = useFieldIds('reset-complete', ['token', 'password']);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');

  const problemFor = (field: string): string | undefined =>
    form.problems.find((problem) => problem.field === field)?.message;

  return (
    <AuthnPage
      title="Choose a new password"
      intro="Paste the code from your reset link and choose a new password."
    >
      <AuthnStatus
        state={form.state}
        problems={form.problems}
        fieldIds={ids}
        formName="reset-complete"
      />
      <form
        className="flex flex-col gap-sp-4"
        data-testid="reset-complete-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(
            () =>
              [
                requiredProblem('token', token, 'A reset code'),
                passwordProblem('password', password),
              ].filter((problem): problem is FieldProblem => problem !== undefined),
            async () => {
              await authn.completePasswordReset(organizationId, { token, password });
              return 'Your password is changed. Sign in with it now.';
            },
          );
        }}
      >
        <Field
          id={ids.token}
          label="Reset code"
          help="From the reset link you were sent. It works once and then expires."
          problem={problemFor('token')}
        >
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="off"
              type="text"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          id={ids.password}
          label="New password"
          help={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`}
          problem={problemFor('password')}
        >
          {(attributes) => (
            <input
              {...attributes}
              className={CONTROL_CLASS}
              autoComplete="new-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="reset-complete-submit"
          disabled={form.state.kind === 'submitting'}
          type="submit"
        >
          Change password
        </button>
      </form>
    </AuthnPage>
  );
}
