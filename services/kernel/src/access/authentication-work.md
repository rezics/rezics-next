# Original Bearer authentication work

## Default producer installation

`createAuthenticator` registers only its original `authenticate` function in a
private `WeakMap`. `createAccess` installs that function by default. `deriveAccess`
copies the registration only when it preserves the base authentication port;
an explicit replacement port does not inherit it. `actorOf` refuses metered
Bearer calls through every unregistered callback before invocation. This keeps
custom callbacks from acquiring a producer by matching a shape or being wrapped.

The registered producer binds one call to its exact token string, native pool,
caller `AccessWorkAccounting` instance and fixed deadline. It reserves one
finite owner declaration before verification, then settles the actual receipt
captured by that same invocation frame. The token, pool identity, claims and
`AccountActor` stay in memory; the work receipt contains only the six Access
axes. No Actor is restored or reconstructed. The original authenticator's
private identity `WeakMap` remains the only proof used after authentication.

The exact native `accountRead` and `delegation-read.sql` evaluators stay in
place. Their existing `account-state` and `assignment` declarations run before
their statement dispatches. Each reached `Pool.query` path also reserves its
checkout point before the query. The delegated statement is reached only after
the verified token contains a canonical `requested_by` value; it still checks
the original creator, actor, current range, account state and fence.

## Limits and cost derivation

The verifier remains JOSE's ES256 `jwtVerify` plus `createRemoteJWKSet`; the
producer wraps that resolver only to observe bounded work. It does not replace
JOSE parsing, key selection, signature verification or claim checks. The public
Auth signer admits at most three live ES256/P-256 keys and limits a key ID to
256 UTF-16 code units. Auth's public projection has fixed `kty`, `crv`, `x`,
`y`, `kid`, `alg` and `use` members; P-256 coordinates are 43 base64url
characters each. JSON escaping needs at most six bytes per key-ID code unit,
so the largest compact Auth response is 5,104 bytes for three maximum-length
key IDs. The response reader's 8,192-byte cap admits that full source output
and bounds an unsupported response before JOSE selection. It rejects a set
containing more than three keys. The default verifier keeps its 300,000 ms
JWKS cache, zero cooldown and 2,000 ms transport timeout. With zero cooldown,
one verification can fetch once for a missing/stale cache and once more after
a no-matching-key result. `iss`, `aud`, HTTPS same-origin JWKS checks, ES256-only
verification, required claims, the five-minute lifetime, wall-clock expiry,
`kid` selection, cache behavior and denial mapping remain unchanged.

For `T = UTF-8 bytes of this exact Bearer token`, the JOSE/JWKS declaration is:

| Axis         | Bound        | Meaning                                                        |
| ------------ | ------------ | -------------------------------------------------------------- |
| `keys`       | 6            | Three candidate keys across at most two key-selection passes.  |
| `points`     | 3            | One JOSE verification invocation and at most two HTTP fetches. |
| `witnesses`  | 0            | This producer creates no native witness.                       |
| `rows`       | 6            | At most three JWKS entries parsed for each of two responses.   |
| `bytes`      | `T + 16,384` | Exact token bytes plus two 8,192-byte response caps.           |
| `emptySeeks` | 0            | JOSE does not issue a native empty seek.                       |

The producer composes those values with the existing native declarations and
the real query checkouts. Its full pre-dispatch bound is:

| Path component                                               | `keys` | `points` | `witnesses` | `rows` |          `bytes` | `emptySeeks` |
| ------------------------------------------------------------ | -----: | -------: | ----------: | -----: | ---------------: | -----------: |
| JOSE/JWKS, using token size `T`                              |      6 |        3 |           0 |      6 |     `T + 16,384` |            0 |
| account query checkout                                       |      0 |        1 |           0 |      0 |                0 |            0 |
| `account-state` for one 36-byte account ID and max route     |      1 |        2 |           0 |      2 |              273 |            1 |
| optional assignment query checkout                           |      0 |        1 |           0 |      0 |                0 |            0 |
| `assignment` for three 36-byte UUIDs and a 64-byte timestamp |      2 |        3 |           0 |      2 |              553 |            1 |
| **Total**                                                    |  **9** |   **10** |       **0** | **10** | **`T + 17,210`** |        **2** |

The native byte literals come from `accessNativeDeclaration`'s closed
projections: the account input is at most 67 JSON bytes plus a 206-byte
projection; the assignment input is at most 243 JSON bytes plus a 310-byte
projection. Account and assignment UUIDs are fixed at 36 characters, routes
are 0–65535, and the existing native declaration budgets a 64-byte timestamp.
The assignment row is a maximum branch in the outer declaration because
`requested_by` is read only after signature verification. A direct token does
not dispatch or settle that branch.

Successful receipts report the token's exact byte length, fetched response
bytes, parsed key counts and actual JOSE selection passes, followed by the
actual reached native declarations. Cache hits charge no transport bytes or
JWKS rows. An unknown `kid` can reach both bounded fetches in the same caller
frame. An invalid signature, missing account, absent assignment or
`account_suspended` response settles all successful reached work before the
existing denial is returned. A timeout or dispatched dependency failure burns
the failed declaration through the Access ledger's existing failure rule. No
second ledger, allowance, refund, query interception or token/Actor receipt is
introduced.

The public Auth boundary is supported by
`services/auth/src/signing.ts` and `services/auth/README.md`: three live public
signing slots, ES256/P-256 material, 256-character key IDs and the exact public
JWKS projection. The original SQL bodies remain `account-read.sql` and
`delegation-read.sql`.
