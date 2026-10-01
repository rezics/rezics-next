<!-- SPDX-License-Identifier: Apache-2.0 -->
# REZICS Wiki Toolkit

Convert a holder's local files to text units with exact locators, then verify
passages against the same edition. The package works offline without a REZICS
account. It fetches nothing, sends no telemetry and runs no model or embedded
script. It writes only JSON Lines to standard output and errors to standard error.

Requires Bun 1.4.2+. This package distributes TypeScript source; Bun executes it
both in a workspace and when installed under `node_modules`.
Install `@rezics/wiki-toolkit` with your package manager, then run:

```sh
rezics-wiki units novel.txt
rezics-wiki units novel.txt --encoding Shift_JIS
rezics-wiki verify novel.txt '{"version":"rezics-locator-v1","source":...,"selector":...}'
```

The last argument is a complete locator JSON object copied from a unit or made
with `locate`, shell-quoted as a single argument. `verify` emits one JSON object
with `quote`, `context.prefix`, `context.suffix` and the locator; failure exits 1.
For a locator too large for a shell argument, pass `-` and supply the locator JSON
on stdin: `rezics-wiki verify novel.epub - < locator.json`.
TXT verification uses the same `--encoding` choice as extraction.

- **TXT:** UTF-8 and BOM-marked UTF-16; reversible Shift_JIS detection; declared
  UTF-8, UTF-16LE/BE, Shift_JIS, Windows-1252, Latin-1 and ASCII. Detection reports
  uncertainty rather than claiming the language or encoding is certain. Original
  bytes, BOM displacement and CRLF are preserved for half-open byte ranges.
  TXT CLI hashing and decoding stream through 64 KiB chunks with stdout
  backpressure. Files over 128 MiB fail before output; chapters/long lines split
  into byte-pinned segments of at most 256 KiB. The in-memory `parseFile` helper
  additionally caps retained units at 4096. Verification accepts ranges of at most
  256 KiB. Chapter headings and separators propose boundaries; confirm Work alignment.
- **EPUB 2/3:** XHTML in package spine order, with navigation labels when present.
  Ruby bases remain in unit text; readings have separate `ruby` records. Range
  [CFIs](https://idpf.org/epub/linking/cfi/) use UTF-16 offsets and escaped IDs,
  with quote fallbacks. Font obfuscation is ignored without decoding fonts; other
  encryption fails. Input is limited to 128 MiB expanded archive data. External
  spine resources, custom entities and unsupported spine media fail. EPUB text uses
  XML character data, including whitespace, rather than browser layout.
- **Ren’Py `.rpy`:** UTF-8 literal say and menu statements in labels, static branch
  conditions and jump metadata. Speakers requiring expressions remain unknown.
  Python blocks are skipped; expressions and interpolation are never evaluated.
  Guards describe the source, not runtime reachability. No archives, compiled
  scripts, runtime hooks or protected-player integration are supported.

Every locator pins the complete representation SHA-256. Changing any byte rejects
the old locator. A unique EPUB quote fallback can recover a path difference in
that same representation; verification marks it as `resolution: "quote-fallback"`.
Ambiguous fallbacks fail. Changed editions require explicit alignment.

For a short passage inside a unit:

```ts
import { parseFile } from '@rezics/wiki-toolkit';
const parsed = parseFile(bytes, 'txt');
const unit = parsed.units[0];
const locator = parsed.locate(unit, start, end); // UTF-16 positions in unit.text
const result = parsed.verify(locator);
```

Install the package's `skill/` payload into your agent's skill directory under the
name `rezics-wiki` (matching its frontmatter). It needs the installed package and
the holder's existing API/MCP connection. Use the [agent skill](skill/SKILL.md) to discover the Work and parts, extract atomic
claims, match names and validate a proposal through a compatible server. Only the
agent makes API calls. The toolkit prints complete local units; an agent should
send REZICS only proposed records, exact locators and short quotations. A provider
model receives whatever text its agent supplies. For strict local processing, use
a local model and disable provider-backed tools that can read the corpus.

The toolkit contains no decryption, key recovery or protection bypass. Protected
or unsupported input fails; there is no bypass fallback. Examples use the admitted
public-domain Jane Austen text and original test scaffolding. This division of
responsibilities does not establish legal clearance for a file or a publication.

The package and protocol are Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
They import no REZICS service implementation. Dependency versions and permissive
licences are recorded in NOTICE. There is no database, uploader, local MCP server,
REZICS authentication client or inference integration.
