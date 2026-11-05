# CLI operator key rotation

The frozen native outcome is `Operator key rotation and current authority during durable resume` in
`services/kernel/test/imports/cli-key-rotation.test.ts`. Its fixture calls actual `runImportCli` three times against
one `openApiRuntime`, using the exported `identitySupport`, `openApiObserver` and runtime `mediaBoundary`.
The initial invocation reads a complete synthetic Bangumi JSONL record, installs its bootstrap and cover,
then loses an actual committed proposal response before local acknowledgement. The HTTP boundary aborts that
invocation after observing the server response; it supplies no native response or authority.

The source contains only synthetic catalogue metadata, summary and a cover URL on the existing admitted Bangumi
host. `bangumi@3` supplies the actual data digest, `unversioned` native revision, source rights and converter
envelopes. The log records the raw input SHA-256 separately from the converter's sanitized source digest, plus
the actual definitions catalogue version and release digest. The media boundary supplies deterministic image
bytes and object storage while the real registered worker executes its native jobs.

The ordinary operator stages, approves and applies a new Auth key on the same account, replaces the mode-0600
private JWK on tmpfs at the same path, and stages, approves and applies `{ kind: 'key', kid, remove: true }` for
the old key. Installation precedes retirement. A retained old signing key asks native Auth to sign in after
retirement and receives its actual denial. The resumed CLI supplies its own native sign-in and token exchanges;
account, client, key IDs and scopes come from captured requests and issued-token claims. Auth's configured JWKS
is read through its real handler. No token, assertion, session cookie or private JWK is logged.

Grant revocation precedes exact replay of the lost request with its original bearer. This observes current
authority independently of key retirement. Only the existing ordinary Global grant is restored. A successful
resume must send the persisted envelope bytes and command keys, retain the original native receipt response,
transaction and row version, and leave existing candidate row versions and the native media object intact.
The later unchanged CLI invocation must have zero public writes. Bootstrap journal bytes and acknowledgement,
media journal bytes, keys and status, completed source records, public subject responses and actual media
worker calls are independently observed. SQLite state lives under `os.tmpdir()` and keys under `/dev/shm`;
cleanup closes the single runtime and removes only this fixture's temporary directories.

## Verification

Managed native acceptance command:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-key-rotation.test.ts
```

The raw native log emits `CLI key rotation native evidence` with exact run, subject, receipt and media anchors,
prepared request bytes and keys, source/converter/bundle revisions and registered child workflow names/counts.
Check IDs, tested code revisions, results and log paths belong in the delivery summary; this document does not
claim a pass before execution. The frozen test remains unchanged. The added local importer test verifies
replacement at the same path, cryptographic assertion signing, cached bearer policy and unchanged six scopes
without a native stack; it cannot establish native acceptance.

## Bound and limitations

- Touches: one supplied record and image, exact source/run/record/subject/receipt/media anchors, existing bounded
  tuple fences and ordinary Auth/public requests. Observation queries lead with full native partition keys or
  exact SQLite source and owner keys, and retain bounded rows.
- Bound: existing acquisition, converter, transport, command and worker limits apply unchanged. The journey
  adds scheduling and observation, with no catalogue, source-history or unrelated-account scan.
- Growth check: existing local and native growth evidence retains its original units and literal bounds. This
  focused caller supplies no new PostgreSQL growth series or buffer count; missing growth evidence stays missing.

No production defect is presumed from the previously missing connected caller. Existing production CLI credential,
transport and durable-import contracts are exercised directly. This slice adds no credential policy, public action,
SourceRegistration option, vocabulary, general source metadata, source licence inference or provider expansion.
It does not claim key retirement revokes existing bearers or exercise VNDB's seventh scope.

Sources read for this binding: `services/importer/src/{cli,credentials,import-client,importer,import-session,run-store,
record-bindings,source-registry}.ts`, `packages/conversion/src/bangumi.ts`, Auth's `src/index.ts` and
`src/credential-effects.ts`, and the existing native `cli-native-auth.test.ts`, `identity-key-credential.test.ts`,
`identity-fixture.ts`, `api-runtime.ts`, `api-observer.ts`, `media-boundary.ts` and
`cover-native-recovery-fixture.ts`. The source contract is the importer and conversion READMEs. No external
reference implementation is ported or newly researched.
