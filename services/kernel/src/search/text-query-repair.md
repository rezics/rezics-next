# Rejected text query repair

Search owns the text grammar in `packages/search-text/src/index.ts`. Kernel admission and the Search editor consume
that pure public entry; native query compilation stays in `text.ts`. Moving the parser does not change terms,
phrases, Boolean precedence, supported escapes, positive-query admission, analyzers or matching.

Decision: use the existing operation problem extension for a closed `textDiagnostic`, retaining `/text` field errors;
leave the shared HTTP field-error contract unchanged. The standalone core has two production consumers, Kernel
Search and Web Search, and no effectful dependencies.

`POST /v1/subjects:search` declares optional `textDiagnostic` on `422 unsupported_query` using
`http/text-diagnostic.ts`. The additive producer input is that mounted response schema, including its closed reason
enum, ranges and bounds. Content's sole complete-input publisher owns regenerating the mounted OpenAPI/client
artifacts; Search does not edit those generated files. Existing consumers may ignore the optional extension.

A diagnostic carries no query, filter, labels, exception message or stack. `start` and `end` are zero-based,
end-exclusive UTF-16 offsets; `unit` is always `utf16`. `codePointStart` and `codePointEnd` are separate zero-based
Unicode code-point offsets. `byteOffset` is the UTF-8 byte count before `start`. Offsets stop at the existing
512-byte parser budget, with at most one offending code point or a two-code-point unsupported escape in the range.
An end-of-input operand error has an empty range. An unclosed phrase/group selects its opening delimiter. The
byte/depth/leaf/phrase-token reasons preserve the existing limits: 512 UTF-8 bytes, four group levels, 64 leaves,
and 32 phrase tokens. Phrase tokens count each CJK code point and each other letter/number run.

Web binds the diagnostic to the exact text captured before the request's first await and admits it only on the
matching unsupported `/text` response. It verifies the closed diagnostic with the same pure parser. Credentials,
readiness and scope refusals retain their own outcomes. The existing retiring reader owns pending reads; no new
session registry or fallback request is introduced. Current query, locale and reader identity key the editor and
retire drafts and pending focus on replacement. No initial response takes focus.

The editor retains the whole original text, shows localized grammar advice and character position, and hides old
advice as soon as the draft differs. Only deliberate Apply validates the draft. A failing Apply may select the
range while its initiating control still holds focus; a focus move, draft edit, replacement or unmount cancels it.
A successful Apply changes only query text and drops the old hit cursor, preserving kind, filter tree, ordered
languages, rating population and resource scope. A future Retry-After disables Apply until its deadline; expiry
never submits. Over-budget URL text uses this same editor through SearchInputRecovery. No text is rewritten,
removed, truncated or retried automatically.
