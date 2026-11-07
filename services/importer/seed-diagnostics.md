# Seed denial diagnostics

Decision: dump acquisition errors use the import request-diagnostic registry for locally constructed operation,
phase, status and source location. Supported operations are `dump-download` and `dump-index`; phases distinguish
network, HTTP, response and integrity failures. The source location contains only URL origin and path, excluding
userinfo, query and fragment. The original cause stays on the private Error chain. `seed-cli.ts` formats only
registered fields, and ordinary Error messages and names never become stderr text. The cross-media CLI preserves
reviewed-catalogue formatting and artifact attribution through `seedFailureDetail`.

Decision: seed HTTP diagnostics capture the first native 401/403 per transport under the importer journal's
`diagnostics/` directory. A private response body preserves exact problem bytes with status, request method/path
and SHA-256 metadata. Structured stderr reports only the HTTP operation stage, status, Subject and artifact path;
it never reports remote text, headers or credentials. This identifies the denied HTTP boundary, not an internal
authorization decision. Denials remain refusals; diagnosis changes neither grants nor replay commands.
