"""Mutual authentication for the solver RPC channel — SPEC-04 §1.1.

SPEC-04 §1.1 states the requirement and not the mechanism:

    | **Authentication** | Mutual authentication on the internal channel; the
    | worker rejects unauthenticated requests |

ADR-0020 repeats the same sentence. Doc 35 §6a's Required behaviour narrows the
choice to a stated pair — "shared-secret or mTLS per SPEC-04" — and forbids
inventing a third. **This module implements the shared-secret member of that
pair, made genuinely mutual**, and the choice is recorded as a ruling in the
packet's return report rather than assumed to be settled.

Why this one:

* **mTLS authenticates a transport.** There is no TLS transport here: one solve
  occupies one subprocess and the frame travels over that subprocess's stdio,
  which is a private channel created by the parent. Provisioning a certificate
  authority to authenticate a pipe would be ceremony around a property the
  operating system already guarantees, and it is not provisionable in this
  environment at all (FAD-7: no Docker, no PKI).
* **A bearer token is not mutual.** A shared secret presented one way proves the
  caller to the worker and proves nothing to the caller. SPEC-04 says *mutual*,
  so both directions are authenticated.

## The MAC covers THE BYTES RECEIVED — never a re-derivation of them

**This is the correction of a real defect.** The first version re-derived its own
canonical form of the parsed request with ``json.dumps(..., ensure_ascii=True)``
and MACed that, while the platform had signed a different rendering. For pure
ASCII the two coincided and every test passed; they diverge for any non-ASCII
character, because ``ensure_ascii=True`` emits ``\\uXXXX`` escapes where
JavaScript emits raw UTF-8. A period named "Février 2029" failed to authenticate
every time, through the real production path.

``ensure_ascii=False`` would have closed that instance and left the class open —
the two runtimes also sort object keys differently above the BMP (UTF-16 code
unit versus code point). Two independent canonicalisations that must agree
byte-for-byte across two languages is a standing liability.

So the wire is **framed**, the tag travels beside the body, and the MAC is taken
over the body **exactly as received**::

    <auth line: one-line JSON, ASCII by construction>\\n<body bytes, verbatim>

Nothing is re-serialised in order to verify. This is the webhook-signature
pattern and it maps to HTTP unchanged.

Three properties, each closing a specific attack:

1. **Domain separation** — request and response MACs cover different prefixes,
   so a captured request MAC cannot be replayed as a response MAC.
2. **The auth metadata is inside the MAC** — scheme, principal, key id and nonce
   sit in the prefix, so moving the tag beside the body does not leave them
   editable.
3. **Constant-time comparison** — ``hmac.compare_digest``, because a byte-by-byte
   ``==`` on a MAC is a timing oracle.

**No secret is ever logged, echoed, or included in an error** (I-07, non-bypass
rule 9). Every failure raises :class:`AuthenticationError` with the same code.
"""

from __future__ import annotations

import hmac
import json
import os
import re
from hashlib import sha256
from typing import Any, Dict, Optional, Tuple

AUTH_SCHEME = "sp-hmac-sha256-mutual-v1"

PRINCIPAL_PLATFORM = "schedulepoint-api"
PRINCIPAL_WORKER = "schedulepoint-solver"

_REQUEST_DOMAIN = "SP-SOLVER-RPC-v1|request|"
_RESPONSE_DOMAIN = "SP-SOLVER-RPC-v1|response|"

FRAME_SEPARATOR = b"\n"

#: A MAC tag as it appears on the wire. Validated as a SHAPE before any
#: comparison — see :func:`_presented_mac` for why that is load-bearing.
_MAC_PATTERN = re.compile(r"^[0-9a-f]{64}$")

#: The environment variables the secret arrives in. **No default.** A worker
#: that cannot find its secret refuses every request rather than accepting
#: everything, which is the same fail-closed direction the provider boundary
#: takes when its probe is missing.
SECRET_ENV = "SP_SOLVER_RPC_SECRET"
KEY_ID_ENV = "SP_SOLVER_RPC_KEY_ID"

#: A secret shorter than this is refused outright. 32 bytes is the output width
#: of the MAC; a key materially shorter than its own tag is a configuration
#: mistake, and accepting it would make the control decorative.
MIN_SECRET_BYTES = 32


class AuthenticationError(Exception):
    """Raised when a message does not authenticate. Carries no material."""

    def __init__(
        self,
        code: str = "unauthenticated",
        message: str = "message did not authenticate",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def load_key() -> Tuple[str, bytes]:
    """The key id and secret from the environment, or a refusal.

    Reads, validates, and returns. It does not cache: a module-level cache would
    keep the material resident for longer than the single message that needs it,
    in a process whose whole design is one solve and exit.
    """
    secret = os.environ.get(SECRET_ENV, "")
    key_id = os.environ.get(KEY_ID_ENV, "")
    if secret == "" or key_id == "":
        raise AuthenticationError(
            "auth_not_configured",
            "the solver RPC secret is not configured; every request is refused",
        )
    material = secret.encode("utf-8")
    if len(material) < MIN_SECRET_BYTES:
        raise AuthenticationError(
            "auth_not_configured",
            "the configured solver RPC secret is shorter than the minimum",
        )
    return key_id, material


def _mac(domain: str, parts: Dict[str, str], body: bytes, secret: bytes) -> str:
    """HMAC over the framing prefix and the body bytes, verbatim.

    Newline-delimited over fields that cannot contain a newline (a fixed scheme,
    a fixed principal, and two identifiers validated on receipt), so the framing
    is unambiguous without escaping.
    """
    prefix = "%s%s\n%s\n%s\n%s\n" % (
        domain,
        parts["scheme"],
        parts["principal"],
        parts["keyId"],
        parts["nonce"],
    )
    return hmac.new(secret, prefix.encode("utf-8") + body, sha256).hexdigest()


def split_frame(raw: bytes) -> Tuple[bytes, bytes]:
    """Split at the FIRST newline. Raises when there is no separator.

    The body is returned verbatim — no strip, no re-encode. Trimming would change
    the bytes the MAC was computed over, which is the mistake this design exists
    to remove.
    """
    index = raw.find(FRAME_SEPARATOR)
    if index == -1:
        raise AuthenticationError("malformed_frame", "the request is not a framed message")
    return raw[:index], raw[index + 1 :]


def _presented_mac(envelope: Dict[str, Any]) -> str:
    """The tag from the auth line, validated as a SHAPE first.

    ``hmac.compare_digest`` raises ``TypeError`` when handed a ``str`` containing
    non-ASCII — so a request whose ``mac`` field held, say, an accented character
    used to escape the auth path entirely and surface as an uncaught traceback
    with no response written, which the parent then attributed as a *kill*. The
    module's own promise that "every failure returns the same class and code" was
    therefore not true. Checking the shape makes it true: anything that is not 64
    lowercase hex characters is refused on the ordinary path, before the crypto
    layer is reached.
    """
    presented = envelope.get("mac")
    if not isinstance(presented, str) or _MAC_PATTERN.match(presented) is None:
        raise AuthenticationError()
    return presented


def verify_request_frame(auth_line: bytes, body: bytes) -> Dict[str, Any]:
    """Authenticate an inbound request frame, or raise.

    Runs **before** the body is parsed. An unauthenticated request is refused
    without any of its payload having been read, because reading is the beginning
    of trusting: a parser exposed to an unauthenticated party is where
    resource-exhaustion bugs live.

    Every failure returns the same class and code. Distinguishing "unknown key
    id" from "bad MAC" would hand an attacker a free oracle for key-id
    enumeration, and neither answer helps a legitimate caller.
    """
    key_id, secret = load_key()

    try:
        envelope = json.loads(auth_line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise AuthenticationError()
    if not isinstance(envelope, dict):
        raise AuthenticationError()

    if envelope.get("scheme") != AUTH_SCHEME:
        raise AuthenticationError()
    if envelope.get("principal") != PRINCIPAL_PLATFORM:
        raise AuthenticationError()
    if envelope.get("keyId") != key_id:
        raise AuthenticationError()
    nonce = envelope.get("nonce")
    if not isinstance(nonce, str) or len(nonce) < 16:
        raise AuthenticationError()

    presented = _presented_mac(envelope)
    expected = _mac(
        _REQUEST_DOMAIN,
        {
            "scheme": AUTH_SCHEME,
            "principal": PRINCIPAL_PLATFORM,
            "keyId": key_id,
            "nonce": nonce,
        },
        body,
        secret,
    )
    if not hmac.compare_digest(expected, presented):
        raise AuthenticationError()
    return envelope


def frame_response(
    response: Dict[str, Any],
    request_nonce: Optional[str],
    key_id: str,
    secret: bytes,
    serialize: Any,
) -> bytes:
    """Serialise, sign the resulting BYTES, and frame.

    The request's nonce is echoed and is inside the MAC prefix, which binds this
    response to that request. Without the binding a valid response could be
    replayed against a later solve of the same problem — and because the
    canonical input hash would match, the platform would have no way to tell.
    """
    body = serialize(response).encode("utf-8")
    parts = {
        "scheme": AUTH_SCHEME,
        "principal": PRINCIPAL_WORKER,
        "keyId": key_id,
        "nonce": request_nonce or "",
    }
    auth = dict(parts)
    auth["mac"] = _mac(_RESPONSE_DOMAIN, parts, body, secret)
    return json.dumps(auth, sort_keys=True, separators=(",", ":")).encode("utf-8") + FRAME_SEPARATOR + body


def unsigned_auth_line(code: str) -> bytes:
    """The auth line for a refusal the worker cannot sign.

    A request that failed to authenticate cannot be answered with a MAC — the key
    it was signed with is not the key this worker holds, or there is no key at
    all. So the refusal carries a declared, explicitly unsigned envelope rather
    than an absent one: the platform's own verdict refuses it on the
    ``unauthenticated`` arm, and a reader of the transcript can see that the
    worker *said* it could not sign rather than having to infer it.
    """
    return json.dumps(
        {"scheme": AUTH_SCHEME, "principal": PRINCIPAL_WORKER, "signed": False, "code": code},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
