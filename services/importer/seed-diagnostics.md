# Seed denial diagnostics

Decision: seed HTTP diagnostics capture the first native 401/403 per transport under the importer journal's
`diagnostics/` directory. A private response body preserves exact problem bytes with status, request method/path
and SHA-256 metadata. Structured stderr reports only the HTTP operation stage, status, Subject and artifact path;
it never reports remote text, headers or credentials. This identifies the denied HTTP boundary, not an internal
authorization decision. Denials remain refusals; diagnosis changes neither grants nor replay commands.
