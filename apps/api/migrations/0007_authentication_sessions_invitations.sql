-- OPUS-M3-001 — authentication, sessions, invitation/activation, password reset,
-- and TOTP multi-factor state.
--
-- ADDITIVE ONLY. 0001..0006 are applied and are never edited. Every statement
-- below creates a new object, adds a column, adds a grant, or adds a trigger to
-- an existing table. Nothing is dropped, widened, or relaxed.
--
-- Normative sources:
--   06 §3.2        — `users` (CAR-027), `sessions`, `invitations` rows
--   14 §2, §3, §5  — authentication controls, session posture, hash-stored tokens
--   14 §7          — retention: sessions/invitations purged after expiry,
--                    REVOKED tokens retained for audit
--   SPEC-06 §4     — `session_epoch` is bumped by authentication, privilege
--                    change, impersonation start/end
--   SPEC-11 §3.2   — privileged access is itself audited
--   10 (STM-017/018) — invitation and user-account lifecycles
--   SPEC-01 §4.3   — predicate spelling, tenant-qualified uniques, composite FKs
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in 0001 and is not repeated. What IS repeated is the spelling
-- itself, per reference, because `apps/api/test/tenancy/roles-and-schema.test.ts`
-- (A-03b) reads `pg_policies` and asserts every individual `current_setting`
-- occurrence is nullif-guarded — and a helper function would hide the one that
-- was not.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ## THREE THINGS A REVIEWER SHOULD CHECK FIRST
--
-- 1. **No table here stores a token.** `sessions`, `invitations` and
--    `password_reset_tokens` each store `token_hash bytea` and no column that
--    could hold the presented value. `user_mfa` is the one exception and cannot
--    be otherwise — a TOTP shared secret must be recoverable to verify a code —
--    so it is stored ENCRYPTED with an authenticated cipher and the ciphertext,
--    nonce, tag and key version are separate columns (14 §5, SPEC-07 §3's
--    envelope pattern applied to a second class of delivery-grade secret).
--
-- 2. **`session_epoch` is still not application-writable.** 0001 deliberately
--    excludes it from the column-level UPDATE grant, so this migration does not
--    add one. It moves through two SECURITY DEFINER functions below, and one of
--    them is a BEFORE INSERT trigger on `sessions`, which is what makes
--    SPEC-06 §4's "bumped by authentication" structural rather than remembered.
--
-- 3. **Suspension invalidates live sessions in the database**, not in a service
--    method somebody has to call. `memberships_revoke_sessions_on_status_change`
--    fires on the membership transition itself.
--
-- ## DISCLOSED SCHEMA ADDITION BEYOND THE PACKET'S DECLARED SET
--
-- The packet declares `sessions`, `invitations`, `users` additions and
-- `user_mfa`. It ALSO requires password reset to use "a separate flow and a
-- **separate token namespace** from invitation/activation (STM-017/018)". Those
-- two requirements cannot both be met with the declared tables: putting reset
-- tokens in `invitations` under a `purpose` discriminator is the same namespace,
-- which is the thing forbidden. `password_reset_tokens` below is therefore a
-- FIFTH object, pre-declared here in the same spirit as the packet's own
-- pre-declared `user_mfa` amendment, additive, RLS-forced in this migration, and
-- flagged in the return report for FAD ratification or rejection. Nothing else
-- in this migration depends on it: rejecting it removes one table, one policy
-- and one service module.

-- Up Migration

------------------------------------------------------------------------------
-- users — credential material and lockout state.
--
-- ## What is added, and what is deliberately NOT
--
-- `password_hash` holds an ENCODED hash string (algorithm, parameters, salt and
-- digest in one self-describing value), never a bare digest: a stored hash whose
-- parameters live in application configuration cannot be re-parameterised
-- without invalidating every credential, and the parameters WILL be raised.
--
-- `activated_at` carries STM-018's `invited -> active` edge. 0001's `status`
-- column is `active | deactivated` and this migration does not widen its CHECK —
-- widening a constraint on an applied migration is not additive in the sense
-- that matters, because the old shape is what every existing row was written
-- against. The account state is therefore DERIVED from the pair, in one place
-- (`apps/api/src/authn/account-state.ts`), and `archived` is NOT representable
-- and NOT claimed by this milestone.
--
-- Lockout is three columns rather than a "locked" boolean, because T-22's
-- control is "progressive delay plus rate limiting" and a boolean cannot express
-- progression. `locked_until` is the deadline the sign-in path compares against
-- the injected clock; `failed_sign_in_count` is what makes the delay
-- progressive; `last_failed_sign_in_at` is what lets the count decay.
------------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN password_hash          text,
    ADD COLUMN password_updated_at    timestamptz,
    ADD COLUMN activated_at           timestamptz,
    ADD COLUMN failed_sign_in_count   integer     NOT NULL DEFAULT 0,
    ADD COLUMN last_failed_sign_in_at timestamptz,
    ADD COLUMN locked_until           timestamptz;

ALTER TABLE users
    ADD CONSTRAINT users_failed_sign_in_count_non_negative
        CHECK (failed_sign_in_count >= 0),
    -- A hash is present exactly when the credential has a set-at time. The pair
    -- is what "this account has a usable password" means, and letting them
    -- disagree is how a credential ends up with no audit answer to "when".
    ADD CONSTRAINT users_password_hash_shape
        CHECK ((password_hash IS NULL) = (password_updated_at IS NULL)),
    -- The encoded form is checked here, not only in TypeScript. A bare digest
    -- written by a migration or a maintenance script would verify against
    -- nothing and fail closed — but silently, and only at the next sign-in.
    ADD CONSTRAINT users_password_hash_encoded
        CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');

------------------------------------------------------------------------------
-- sessions — server-side sessions, hashed tokens only (14 §3, 06 §3.2).
--
-- ## Why the organization is on the row
--
-- 06 §3.2 tenants this table on the organization, and that is the property that
-- makes "a session is unreachable from another organization" an RLS fact rather
-- than an application promise. It also decides the cookie's shape: the value the
-- browser holds is `<organization_id>.<secret>`, so the resolver knows which
-- tenant context to open BEFORE it looks the token up. Declaring the wrong
-- organization does not widen anything — the policy simply matches no row and
-- the request is unauthenticated.
--
-- ## Two deadlines, and neither is decorative
--
--   `expires_at`           the IDLE deadline. Slides forward on use.
--   `absolute_expires_at`  the ABSOLUTE deadline. Set once at issue and never
--                          moved; a CHECK and a trigger both say so.
--
-- 14 §3 requires both. One alone is a different control: idle-only lets a stolen
-- token live forever under a keep-alive, absolute-only lets an abandoned session
-- stay usable for its whole window.
------------------------------------------------------------------------------

CREATE TABLE sessions (
    id                     uuid PRIMARY KEY,
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    user_id                uuid NOT NULL REFERENCES users (id),

    -- SHA-256 of the presented secret. There is no column that could hold the
    -- secret itself, which is the only reliable way to keep one out of a backup.
    token_hash             bytea NOT NULL CHECK (octet_length(token_hash) = 32),

    issued_at              timestamptz NOT NULL DEFAULT now(),
    last_seen_at           timestamptz NOT NULL DEFAULT now(),
    expires_at             timestamptz NOT NULL,
    absolute_expires_at    timestamptz NOT NULL,

    state                  text NOT NULL DEFAULT 'active'
                               CHECK (state IN ('active', 'revoked')),
    revoked_at             timestamptz,
    -- A CLOSED vocabulary, not free text (I-17). Every value here is a reason
    -- an incident review searches for by name.
    revoked_reason         text CHECK (revoked_reason IN (
                               'sign_out',
                               'privilege_change',
                               'membership_suspended',
                               'membership_ended',
                               'user_deactivated',
                               'password_changed',
                               'mfa_reset',
                               'login_email_changed',
                               'rotated',
                               'administrative'
                           )),

    -- Whether the MFA challenge has been satisfied on THIS session. A session
    -- that has not is authenticated for the MFA endpoints and nothing else.
    mfa_satisfied          boolean NOT NULL DEFAULT false,

    -- Assigned by the BEFORE INSERT trigger below, from the value the bump
    -- produced. Not application-supplied: an application-supplied epoch could
    -- disagree with the users row it is supposed to describe.
    session_epoch_at_issue bigint NOT NULL CHECK (session_epoch_at_issue > 0),

    -- 14 §3: "persistent option scoped to personal devices". It widens the IDLE
    -- window only; the absolute deadline is unaffected, which is the point.
    persistent             boolean NOT NULL DEFAULT false,

    -- Set when this session replaced another on a privilege change (14 §3
    -- "rotation on privilege change"). The predecessor row is retained revoked.
    rotated_from_session_id uuid,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    -- TENANT-QUALIFIED, like every other unique key on a tenant table.
    -- A primary-key or unique check bypasses RLS, so a GLOBALLY unique key a
    -- caller can influence is an existence oracle for invisible rows (X-11).
    -- The probability of a 256-bit collision is not the point: the property is
    -- structural, and the lookup carries the organization anyway — it comes from
    -- the cookie before the query runs.
    CONSTRAINT sessions_token_hash_unique UNIQUE (organization_id, token_hash),
    CONSTRAINT sessions_tenant_identity   UNIQUE (id, organization_id),

    CONSTRAINT sessions_idle_within_absolute
        CHECK (expires_at <= absolute_expires_at),
    CONSTRAINT sessions_revocation_shape
        CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)
           AND (state = 'revoked') = (revoked_reason IS NOT NULL))
);

CREATE INDEX sessions_by_user ON sessions (organization_id, user_id, state);
CREATE INDEX sessions_by_expiry ON sessions (organization_id, absolute_expires_at);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;

-- Organization-scoped and group-blind: a session belongs to an identity in an
-- organization, not to a group, and it must remain resolvable while a
-- group-scoped request is being served. `app.group_id` is therefore deliberately
-- absent from the predicate rather than forgotten.
CREATE POLICY sessions_organization_scope ON sessions
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

------------------------------------------------------------------------------
-- invitations — STM-017, single-use and expiring (14 §2, 06 §3.2).
--
-- `consumed_at` is set by a CONDITIONAL UPDATE (`WHERE consumed_at IS NULL`),
-- so two concurrent consumers of the same token contend on the row lock and
-- exactly one observes a row. That is the whole single-use mechanism; there is
-- no second check anywhere that could disagree with it.
--
-- The invitation names the user row it activates. A user is provisioned in the
-- `invited` account state (no `password_hash`, no `activated_at`) when the
-- invitation is issued, so the membership exists before activation — which is
-- what makes the activation request resolvable under an organization context at
-- all.
------------------------------------------------------------------------------

CREATE TABLE invitations (
    id                     uuid PRIMARY KEY,
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    user_id                uuid NOT NULL REFERENCES users (id),

    -- The address the invitation was issued to. Reconciled against
    -- `users.login_email` when an administrator changes it (CAR-027).
    email                  text NOT NULL CHECK (length(btrim(email)) > 0),

    token_hash             bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    expires_at             timestamptz NOT NULL,
    consumed_at            timestamptz,

    state                  text NOT NULL DEFAULT 'pending'
                               CHECK (state IN ('pending', 'accepted', 'expired', 'revoked')),

    issued_by_membership_id uuid,
    revoked_at             timestamptz,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    -- Tenant-qualified — X-11, see `sessions_token_hash_unique`.
    CONSTRAINT invitations_token_hash_unique UNIQUE (organization_id, token_hash),
    CONSTRAINT invitations_tenant_identity   UNIQUE (id, organization_id),

    CONSTRAINT invitations_acceptance_shape
        CHECK ((state = 'accepted') = (consumed_at IS NOT NULL)),
    CONSTRAINT invitations_revocation_shape
        CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX invitations_by_user ON invitations (organization_id, user_id, state);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY invitations_organization_scope ON invitations
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

------------------------------------------------------------------------------
-- password_reset_tokens — the DISCLOSED addition (see the header).
--
-- A separate table, a separate state domain, and — in `apps/api/src/authn/
-- tokens.ts` — a separate HMAC domain label, so a reset token cannot be
-- presented to the activation endpoint or the reverse even if the two hashes
-- were somehow made to collide. 14 §2: "Password reset … does not double as
-- activation."
------------------------------------------------------------------------------

CREATE TABLE password_reset_tokens (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL REFERENCES organizations (id),
    user_id           uuid NOT NULL REFERENCES users (id),

    token_hash        bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    expires_at        timestamptz NOT NULL,
    consumed_at       timestamptz,

    state             text NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'consumed', 'expired', 'revoked')),
    revoked_at        timestamptz,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Tenant-qualified — X-11, see `sessions_token_hash_unique`.
    CONSTRAINT password_reset_tokens_token_hash_unique UNIQUE (organization_id, token_hash),
    CONSTRAINT password_reset_tokens_tenant_identity   UNIQUE (id, organization_id),

    CONSTRAINT password_reset_tokens_consumption_shape
        CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
    CONSTRAINT password_reset_tokens_revocation_shape
        CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX password_reset_tokens_by_user
    ON password_reset_tokens (organization_id, user_id, state);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY password_reset_tokens_organization_scope ON password_reset_tokens
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

------------------------------------------------------------------------------
-- user_mfa — the PRE-DECLARED additive doc-06 amendment (packet §3).
--
-- ## Why the secret is encrypted and not hashed
--
-- A TOTP verifier must recompute HMAC(secret, time_step) to check a code, so it
-- needs the secret back. Hashing is therefore not available and pretending
-- otherwise would produce a column that verifies nothing. The control is
-- AES-256-GCM with a key held outside the row: `secret_ciphertext`,
-- `secret_nonce` and `secret_tag` are separate columns so a truncated or
-- tampered ciphertext fails authentication rather than decrypting to rubbish,
-- and `key_version` is SPEC-07 §3's envelope-rotation field applied to a second
-- class of secret.
--
-- **The key is NOT isolated in this deployment**, exactly as the audit
-- checkpoint signer's key is not (FAD-7). `apps/api/src/authn/secret-box.ts`
-- carries a `keyIsIsolated = false` flag for the same reason and with the same
-- honesty: an actor who can read this table in a local deployment can also read
-- the key. Real key custody is a named deployment condition, not a claim.
--
-- ## Replay defence
--
-- `last_accepted_time_step` is monotonic, enforced by a trigger rather than by
-- the code that writes it. RFC 6238 codes are valid for a whole step, so without
-- this a captured code is replayable for up to `period_seconds` — which is
-- exactly long enough for the attack the challenge exists to prevent.
--
-- ## Recovery codes
--
-- Hashed, in `recovery_codes`, as an array of `{"h": <hex>, "c": <iso|null>}`.
-- One row per enrolment rather than a child table because the packet declares
-- `user_mfa` as holding them, and because consumption must be atomic with the
-- enrolment row it belongs to — a conditional UPDATE on this row is that atom.
------------------------------------------------------------------------------

CREATE TABLE user_mfa (
    id                      uuid PRIMARY KEY,
    organization_id         uuid NOT NULL REFERENCES organizations (id),
    user_id                 uuid NOT NULL REFERENCES users (id),

    method                  text NOT NULL DEFAULT 'totp' CHECK (method IN ('totp')),

    secret_ciphertext       bytea NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 16 AND 256),
    secret_nonce            bytea NOT NULL CHECK (octet_length(secret_nonce) = 12),
    secret_tag              bytea NOT NULL CHECK (octet_length(secret_tag) = 16),
    key_version             integer NOT NULL CHECK (key_version > 0),

    algorithm               text     NOT NULL DEFAULT 'SHA1'  CHECK (algorithm IN ('SHA1', 'SHA256')),
    digits                  smallint NOT NULL DEFAULT 6       CHECK (digits IN (6, 8)),
    period_seconds          smallint NOT NULL DEFAULT 30      CHECK (period_seconds IN (30, 60)),

    -- `provisioned` means a secret exists but no valid code has been presented,
    -- so the factor is NOT yet in force. 14 §2: enrolment is confirmed by a
    -- valid code before it counts.
    state                   text NOT NULL DEFAULT 'provisioned'
                                CHECK (state IN ('provisioned', 'active')),
    enrolled_at             timestamptz,

    last_accepted_time_step bigint CHECK (last_accepted_time_step > 0),

    recovery_codes          jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(recovery_codes) = 'array'),

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    -- One enrolment per identity per organization. A reset DELETES the row (the
    -- secret must not survive its reset — that is the whole point of X-12) and
    -- the audit chain, not this table, is what retains the history.
    CONSTRAINT user_mfa_one_per_user  UNIQUE (organization_id, user_id),
    CONSTRAINT user_mfa_tenant_identity UNIQUE (id, organization_id),

    CONSTRAINT user_mfa_enrolment_shape
        CHECK ((state = 'active') = (enrolled_at IS NOT NULL))
);

ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_mfa_organization_scope ON user_mfa
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

------------------------------------------------------------------------------
-- session_epoch — SPEC-06 §4, still not application-writable.
--
-- 0001 excludes `session_epoch` from the column-level UPDATE grant on purpose,
-- and this migration does not add one. Two SECURITY DEFINER functions move it,
-- and both are subject to `users`' FORCE RLS, so each can only touch a user
-- visible in the caller's current tenant context — privilege without tenant
-- reach, the same trade 0001's `app_bump_membership_set_version` makes and for
-- the same reason.
--
-- `SET search_path = public, pg_temp` with **pg_temp LAST**: 0001 explains why
-- at length (a temporary `users` table would otherwise shadow the real one), and
-- the reasoning applies here verbatim.
------------------------------------------------------------------------------

CREATE FUNCTION app_bump_session_epoch(p_user_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_epoch bigint;
BEGIN
    UPDATE users
       SET session_epoch = session_epoch + 1,
           updated_at    = now()
     WHERE id = p_user_id
    RETURNING session_epoch INTO v_epoch;

    IF v_epoch IS NULL THEN
        RAISE EXCEPTION
            'SESSION_EPOCH_BUMP_FAILED: user % is not visible in the current tenant context, so '
            'its session_epoch could not be advanced. A privilege change that commits with an '
            'unbumped counter is the condition SPEC-06 §4 calls impossible.', p_user_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN v_epoch;
END;
$$;

REVOKE ALL ON FUNCTION app_bump_session_epoch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_bump_session_epoch(uuid) TO app_runtime, app_worker;

-- "Authentication bumps `session_epoch`" as a property of issuing a session,
-- rather than as a line somebody has to remember in the sign-in handler.
--
-- BEFORE INSERT, so the row can carry the epoch the bump produced. An
-- application-supplied `session_epoch_at_issue` could disagree with the `users`
-- row it claims to describe, and nothing downstream would notice.
CREATE FUNCTION app_session_assign_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_epoch bigint;
BEGIN
    UPDATE users
       SET session_epoch = session_epoch + 1,
           updated_at    = now()
     WHERE id = NEW.user_id
    RETURNING session_epoch INTO v_epoch;

    IF v_epoch IS NULL THEN
        RAISE EXCEPTION
            'SESSION_ISSUE_EPOCH_FAILED: user % is not visible in the current tenant context, so '
            'a session cannot be issued for it', NEW.user_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    NEW.session_epoch_at_issue := v_epoch;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_session_assign_epoch() FROM PUBLIC;

CREATE TRIGGER sessions_assign_epoch
    BEFORE INSERT ON sessions
    FOR EACH ROW EXECUTE FUNCTION app_session_assign_epoch();

------------------------------------------------------------------------------
-- The absolute deadline never moves.
--
-- The idle deadline slides — that is what makes it an idle deadline — and the
-- application slides it on every authenticated request. A grant that permits
-- `expires_at` therefore also permits `absolute_expires_at` unless something
-- else refuses it, and "something else" is this trigger rather than a code
-- review.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_session_absolute_deadline() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
        RAISE EXCEPTION
            'SESSION_ABSOLUTE_DEADLINE_IMMUTABLE: absolute_expires_at is fixed at issue '
            '(% -> %); an idle deadline slides, an absolute one does not',
            OLD.absolute_expires_at, NEW.absolute_expires_at
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.session_epoch_at_issue IS DISTINCT FROM OLD.session_epoch_at_issue THEN
        RAISE EXCEPTION
            'SESSION_EPOCH_AT_ISSUE_IMMUTABLE: the epoch a session was issued under is a fact '
            'about the past and is never rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- A revoked session is terminal. Un-revoking one would resurrect a token
    -- that has already been reported dead in the audit trail.
    IF OLD.state = 'revoked' AND NEW.state <> 'revoked' THEN
        RAISE EXCEPTION
            'SESSION_REVOCATION_TERMINAL: a revoked session is never reactivated'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_session_absolute_deadline() FROM PUBLIC;

CREATE TRIGGER sessions_guard_absolute_deadline
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION app_guard_session_absolute_deadline();

------------------------------------------------------------------------------
-- TOTP step replay, refused at the database.
--
-- The verifier also checks this, and the check in the verifier is the one that
-- produces a useful error message. This trigger is what makes the property true
-- for a second caller, a retry, or a concurrent request that read the same row
-- before either wrote it: the UPDATE that would lower or repeat the step raises.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_mfa_step_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    -- `IS DISTINCT FROM` first, and it is load-bearing rather than tidy: without
    -- it this trigger raises on any UPDATE that leaves the step alone, because
    -- an unchanged value satisfies `NEW <= OLD`. Consuming a recovery code
    -- writes `recovery_codes` and nothing else, and it was refused with a replay
    -- error until this clause was added. Found by running it.
    IF NEW.last_accepted_time_step IS NOT NULL
       AND OLD.last_accepted_time_step IS NOT NULL
       AND NEW.last_accepted_time_step IS DISTINCT FROM OLD.last_accepted_time_step
       AND NEW.last_accepted_time_step <= OLD.last_accepted_time_step THEN
        RAISE EXCEPTION
            'MFA_TIME_STEP_REPLAY: time step % has already been accepted (last %); an RFC 6238 '
            'code is valid for a whole step and is single-use',
            NEW.last_accepted_time_step, OLD.last_accepted_time_step
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_mfa_step_monotonic() FROM PUBLIC;

CREATE TRIGGER user_mfa_guard_step_monotonic
    BEFORE UPDATE ON user_mfa
    FOR EACH ROW EXECUTE FUNCTION app_guard_mfa_step_monotonic();

------------------------------------------------------------------------------
-- Suspension invalidates live sessions IMMEDIATELY (14 §3, T-07).
--
-- In the database, on the membership transition itself, so there is no window
-- between "the membership was suspended" and "somebody remembered to revoke the
-- sessions" — and no code path that can suspend without it.
--
-- Not SECURITY DEFINER: it runs with the caller's privileges under the caller's
-- tenant context, which is the same organization the membership belongs to, so
-- `sessions_organization_scope` admits exactly the rows it should.
------------------------------------------------------------------------------

CREATE FUNCTION app_revoke_sessions_on_membership_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    v_reason text;
BEGIN
    v_reason := CASE NEW.status
                    WHEN 'suspended' THEN 'membership_suspended'
                    WHEN 'ended'     THEN 'membership_ended'
                    ELSE NULL
                END;
    IF v_reason IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE sessions
       SET state          = 'revoked',
           revoked_at     = now(),
           revoked_reason = v_reason,
           updated_at     = now()
     WHERE organization_id = NEW.organization_id
       AND user_id         = NEW.user_id
       AND state           = 'active';

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_revoke_sessions_on_membership_change() FROM PUBLIC;

CREATE TRIGGER memberships_revoke_sessions_on_status_change
    AFTER UPDATE ON memberships
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
      AND NEW.status IN ('suspended', 'ended'))
    EXECUTE FUNCTION app_revoke_sessions_on_membership_change();

------------------------------------------------------------------------------
-- Retention (14 §7): "Purged after expiry; **revoked tokens retained for
-- audit**."
--
-- No runtime role holds DELETE on any tenant table and this migration does not
-- change that. Purging runs through a SECURITY DEFINER function granted to
-- `app_worker` alone, and the function encodes the retention rule itself: a
-- REVOKED row is never removed, whatever its expiry.
--
-- It is subject to RLS like every other owner-run statement here, so it purges
-- within the caller's tenant context and nowhere else.
------------------------------------------------------------------------------

CREATE FUNCTION app_purge_expired_authn_tokens(p_before timestamptz)
RETURNS TABLE (relation text, purged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    DELETE FROM sessions
     WHERE state = 'active' AND absolute_expires_at < p_before;
    GET DIAGNOSTICS n = ROW_COUNT;
    relation := 'sessions'; purged := n; RETURN NEXT;

    DELETE FROM invitations
     WHERE state IN ('pending', 'expired') AND expires_at < p_before;
    GET DIAGNOSTICS n = ROW_COUNT;
    relation := 'invitations'; purged := n; RETURN NEXT;

    DELETE FROM password_reset_tokens
     WHERE state IN ('pending', 'expired') AND expires_at < p_before;
    GET DIAGNOSTICS n = ROW_COUNT;
    relation := 'password_reset_tokens'; purged := n; RETURN NEXT;

    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION app_purge_expired_authn_tokens(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_expired_authn_tokens(timestamptz) TO app_worker;

------------------------------------------------------------------------------
-- SPEC-11 X-12: the enrolment is REMOVED on reset, secret and all.
--
-- A `state = 'reset'` row would keep a decryptable secret in the table after the
-- event whose entire purpose is to invalidate it, and 14 §7's "revoked tokens
-- retained for audit" is satisfied by the audit chain rather than by retaining
-- the secret itself.
--
-- SECURITY DEFINER because **no runtime role holds DELETE on any tenant table**
-- and this migration does not change that (doc 09 §4;
-- `apps/api/test/tenancy/roles-and-schema.test.ts` F/B asserts it per (role,
-- table) pair). The privilege is granted to the FUNCTION, whose body is one
-- statement over one table — and, being owner-run against a FORCE-RLS table, it
-- still cannot reach a user outside the caller's tenant context.
--
-- The capability check (`identity.reset_mfa`) is at the application layer, in
-- the same unit of work, before this is called.
------------------------------------------------------------------------------

CREATE FUNCTION app_reset_user_mfa(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    DELETE FROM user_mfa WHERE user_id = p_user_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION app_reset_user_mfa(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reset_user_mfa(uuid) TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- Grants. Column-level UPDATE, as everywhere else.
--
-- Withheld deliberately, each because the grant is the only available control:
--
--   DELETE                    on all four new tables. Retention is the purge
--                             function above, which encodes the "revoked rows
--                             are retained" rule; a DELETE grant would let any
--                             caller drop the evidence of a revocation.
--   token_hash                is not updatable anywhere. A token's identity is
--                             the token; rewriting the hash would re-point a
--                             live credential at a different secret.
--   organization_id, user_id  are not updatable anywhere. No authentication
--                             artifact is ever re-tenanted or re-owned.
--   absolute_expires_at       IS granted (the column has to be written at
--                             insert) and is then frozen by the trigger above,
--                             which is the control an UPDATE grant cannot be.
--   session_epoch on users    still absent, as 0001 left it.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON sessions, invitations, password_reset_tokens, user_mfa
    TO app_runtime, app_worker;

GRANT UPDATE (last_seen_at, expires_at, state, revoked_at, revoked_reason,
              mfa_satisfied, updated_at)
    ON sessions TO app_runtime, app_worker;

GRANT UPDATE (state, consumed_at, revoked_at, email, expires_at, updated_at)
    ON invitations TO app_runtime, app_worker;

GRANT UPDATE (state, consumed_at, revoked_at, updated_at)
    ON password_reset_tokens TO app_runtime, app_worker;

-- `algorithm`, `digits` and `period_seconds` are updatable because
-- re-provisioning an enrolment replaces the parameters along with the secret:
-- `upsertMfaProvisioning`'s `ON CONFLICT DO UPDATE` names them, and without the
-- grant that statement raises 42501 the first time somebody re-scans a QR code
-- before confirming. They are still not free-form — every one has a CHECK.
GRANT UPDATE (secret_ciphertext, secret_nonce, secret_tag, key_version,
              algorithm, digits, period_seconds,
              state, enrolled_at, last_accepted_time_step, recovery_codes, updated_at)
    ON user_mfa TO app_runtime, app_worker;

GRANT UPDATE (password_hash, password_updated_at, activated_at,
              failed_sign_in_count, last_failed_sign_in_at, locked_until)
    ON users TO app_runtime, app_worker;

-- The support and break-glass roles read; they never write. SPEC-11 §3.2 makes
-- the READ itself auditable, which is a different control from withholding it.
GRANT SELECT ON sessions, invitations, password_reset_tokens
    TO app_readonly_support, app_breakglass;

------------------------------------------------------------------------------
-- SPEC-11 §3.2: the privileged roles APPEND to the audit chain.
--
-- > Every `app_readonly_support`, `app_breakglass`, and `app_migrator` session
-- > records operator identity, ticket reference, statements executed, and rows
-- > touched — **written to the same chained audit stream**.
--
-- Somebody has to write those rows, and it must be the session itself: writing
-- them from a different role in a different transaction would mean a privileged
-- transaction that rolled back still left evidence claiming it happened, and a
-- privileged transaction that committed could have its evidence fail
-- separately.
--
-- **This is an APPEND grant and nothing more**, on exactly the columns 0003
-- grants `app_runtime`. The chain columns (`sequence`, `prev_hash`,
-- `entry_hash`) are absent here as they are there, so naming one raises 42501
-- and the BEFORE INSERT trigger remains the only thing that assigns them. No
-- UPDATE and no DELETE is granted to any role by this migration, and
-- `apps/api/test/tenancy/roles-and-schema.test.ts` asserts that per (role,
-- table) pair.
------------------------------------------------------------------------------

GRANT INSERT (organization_id, id, event_name, actor_kind, actor_membership_id,
              group_id, subject_type, subject_id, correlation_id, payload)
    ON audit_events TO app_readonly_support, app_breakglass;

-- **`user_mfa` is deliberately absent from the support/break-glass grant.**
-- The row holds a decryptable authentication secret; a support read of it is a
-- credential compromise rather than an investigation, and the separation-of-duty
-- argument SPEC-07 §3 makes for push delivery material applies unchanged.

-- Down Migration

DROP TRIGGER IF EXISTS memberships_revoke_sessions_on_status_change ON memberships;
DROP TRIGGER IF EXISTS user_mfa_guard_step_monotonic                ON user_mfa;
DROP TRIGGER IF EXISTS sessions_guard_absolute_deadline             ON sessions;
DROP TRIGGER IF EXISTS sessions_assign_epoch                        ON sessions;

DROP FUNCTION IF EXISTS app_reset_user_mfa(uuid);
DROP FUNCTION IF EXISTS app_purge_expired_authn_tokens(timestamptz);
DROP FUNCTION IF EXISTS app_revoke_sessions_on_membership_change();
DROP FUNCTION IF EXISTS app_guard_mfa_step_monotonic();
DROP FUNCTION IF EXISTS app_guard_session_absolute_deadline();
DROP FUNCTION IF EXISTS app_session_assign_epoch();
DROP FUNCTION IF EXISTS app_bump_session_epoch(uuid);

DROP POLICY IF EXISTS user_mfa_organization_scope               ON user_mfa;
DROP POLICY IF EXISTS password_reset_tokens_organization_scope  ON password_reset_tokens;
DROP POLICY IF EXISTS invitations_organization_scope            ON invitations;
DROP POLICY IF EXISTS sessions_organization_scope               ON sessions;

DROP INDEX IF EXISTS password_reset_tokens_by_user;
DROP INDEX IF EXISTS invitations_by_user;
DROP INDEX IF EXISTS sessions_by_expiry;
DROP INDEX IF EXISTS sessions_by_user;

DROP TABLE IF EXISTS user_mfa;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS sessions;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_password_hash_encoded,
    DROP CONSTRAINT IF EXISTS users_password_hash_shape,
    DROP CONSTRAINT IF EXISTS users_failed_sign_in_count_non_negative;

ALTER TABLE users
    DROP COLUMN IF EXISTS locked_until,
    DROP COLUMN IF EXISTS last_failed_sign_in_at,
    DROP COLUMN IF EXISTS failed_sign_in_count,
    DROP COLUMN IF EXISTS activated_at,
    DROP COLUMN IF EXISTS password_updated_at,
    DROP COLUMN IF EXISTS password_hash;
