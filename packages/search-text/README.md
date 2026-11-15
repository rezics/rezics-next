# @rezics/search-text

Pure parser for one Search text query. It builds a `term`, `phrase`, `not`, `and` and `or` tree and reports a closed syntax diagnostic. It has no effectful dependencies. A result of these functions does not authorize an API call or complete a business operation.

Search owns this grammar and its product policy, including native compilation, wire admission and editor repair. See [Rejected text query repair](../../services/kernel/src/search/text-query-repair.md) in the [Search](../../services/kernel/src/search/README.md) module.

## Public entry

`package.json` exports `"."` (`src/index.ts`). Import from `@rezics/search-text`:

```ts
import {
  TEXT_DIAGNOSTIC_REASONS,
  TEXT_LIMITS,
  TextSyntaxError,
  diagnoseText,
  parseText,
  positiveText,
  readTextDiagnostic,
  textSyntaxProblem,
} from '@rezics/search-text';
import type { TextDiagnostic, TextDiagnosticReason, TextNode } from '@rezics/search-text';
```

## Limits

`TEXT_LIMITS` is frozen: `bytes` 512, `depth` 4, `leaves` 64, `phraseTokens` 32.

Each code point charges its UTF-8 width before the cursor advances. Whitespace counts. 512 bytes are accepted; the next code point is `byte_limit`. Four nested groups are accepted; the fifth `(` is `depth_limit` and is not entered. 64 term or phrase leaves are accepted; the next leaf is `leaf_limit`. Inside one phrase, 32 tokens are accepted; the next token is `phrase_token_limit`.

A phrase token is one Han, Hiragana, Katakana or Hangul code point, or one contiguous run of other letters or numbers (`\p{L}` or `\p{N}`). Whitespace and punctuation add no token and break a run. The count uses the character after escape decoding.

`TEXT_DIAGNOSTIC_REASONS` is the closed list `expected_operand`, `unexpected_close`, `unclosed_group`, `unclosed_phrase`, `unsupported_escape`, `empty_phrase`, `negated_operand`, `byte_limit`, `depth_limit`, `leaf_limit`, `phrase_token_limit`. `TextDiagnosticReason` is that union.

## Parse

```ts
parseText(input: string): TextNode
positiveText(node: TextNode): boolean
```

`TextNode` is `{ kind: 'term' | 'phrase'; value: string }`, `{ kind: 'not'; child: TextNode }`, or `{ kind: 'and' | 'or'; children: TextNode[] }`.

`|` separates `or` branches. Unicode whitespace separates `and` operands and may surround `|`. A `-` glued to the next primary is `not`; `a -b` negates `b`, and `-(a)` negates the group. A `-` followed by the end, whitespace, `-`, `|` or `)` is `negated_operand`. A `-` inside a leaf stays in the value, so `a-b` is one term.

`(` … `)` groups a disjunction and adds no node of its own. `((((a))))` is the term `a`. An empty group — `(`, `()` or `( )` — is `expected_operand` on that `(`. A group that parsed an operand and has no `)` is `unclosed_group` on the opening `(`.

A leaf that begins with `"` is a phrase and runs until the next unescaped `"`. `""` is `empty_phrase` on the opening quote. A missing close is `unclosed_phrase` on the opening quote. A term stops before whitespace, `|`, `(`, `)` or `"`, so both `ab"cd"` and `ab(cd)` are conjunctions.

`\` keeps one following character from `\`, `"`, `|`, `(`, `)` and `-`, and stores it without the backslash. `ab\|cd` is the term `ab|cd`. Any other follower, including end of input, is `unsupported_escape` on the `\`.

Same-kind `and` and `or` nodes are flattened, and a one-child combination is returned as that child. `a|b|c` is one `or` of three terms. The first failure throws. `parseText` returns no partial tree.

`positiveText` is true for a term or phrase and false for `not`, without reading that child. An `and` is true when at least one child is true. An `or` is true when every child is true.

## Diagnostics

```ts
diagnoseText(input: string): TextDiagnostic | undefined
readTextDiagnostic(value: unknown): TextDiagnostic | undefined
textSyntaxProblem(error: TextSyntaxError): {
  errors: [{ pointer: '/text'; code: 'unsupported' | 'out_of_range' }];
  extensions: { textDiagnostic: TextDiagnostic };
}
```

`diagnoseText` returns `undefined` when `parseText` succeeds. It returns the diagnostic of a `TextSyntaxError` and rethrows any other error.

`TextDiagnostic` carries `reason`, `unit: 'utf16'`, `start`, `end`, `codePointStart`, `codePointEnd` and `byteOffset`. `start` and `end` are zero-based UTF-16 boundaries for a textarea selection, with `start` inclusive and `end` exclusive. The code-point fields are that same span in Unicode code points. `byteOffset` is the UTF-8 length before `start`. Each scale stays in its own fields.

The default span is the one code point at `start`: one UTF-16 unit, or two when the code point is supplementary. At the end of the input, `start === end`. `unsupported_escape` also covers the next code point when it exists, so `\q` covers both units and a final `\` covers the backslash. A limit diagnostic still covers the code point that crossed the budget, and `byteOffset` excludes that code point.

`TextSyntaxError` has `name === 'TextSyntaxError'`. `offset` is `diagnostic.start`. `code`, `offset` and `diagnostic` are readonly. A reason ending in `_limit` has code `out_of_range`; every other reason has code `unsupported`. The message is `` `${code} text query at offset ${offset}` ``.

| Reason | `start` |
| --- | --- |
| `expected_operand` | Where an operand is required. Empty input and `a\|` have an empty span. A following `\|` or `)` is covered (`\|`, `(\|)`, `(a\|)`). An empty group points at `(`. |
| `unexpected_close` | A `)` after a finished disjunction (`a)`). A leading `)` is `expected_operand`. |
| `unclosed_group` | The opening `(`. |
| `unclosed_phrase`, `empty_phrase` | The opening `"` of that leaf. |
| `unsupported_escape` | The `\`. |
| `negated_operand` | The `-`. |
| `byte_limit` | The code point beyond 512 UTF-8 bytes. |
| `depth_limit` | The fifth `(`. |
| `leaf_limit` | The leaf after 64, at that leaf's start. |
| `phrase_token_limit` | The code point beyond 32 phrase tokens, or its `\` when that code point is escaped. |

`readTextDiagnostic` returns `undefined` unless `value` is an object, `reason` is in `TEXT_DIAGNOSTIC_REASONS`, and `unit` is `'utf16'`. Each index must be a non-negative safe integer: `start` ≤ 512, `end` ≤ 514, `end >= start`, `end - start` ≤ 3, `codePointStart` ≤ 512, `codePointEnd` ≤ 513, `codePointEnd >= codePointStart`, `codePointEnd - codePointStart` ≤ 2, and `byteOffset` ≤ 512. The UTF-16 span, code-point span, and UTF-8 byte offset must be consistent with one another. Success returns a new object with those seven fields. Other properties are omitted.

`textSyntaxProblem` returns `{ errors: [{ pointer: '/text', code: error.code }], extensions: { textDiagnostic: error.diagnostic } }`. HTTP adapters keep their existing problem identity.

## Examples

```ts
import { parseText, positiveText } from '@rezics/search-text';

const node = parseText('alpha -"beta gamma"');
// {
//   kind: 'and',
//   children: [
//     { kind: 'term', value: 'alpha' },
//     { kind: 'not', child: { kind: 'phrase', value: 'beta gamma' } },
//   ],
// }
positiveText(node); // true
```

```ts
import { diagnoseText, parseText } from '@rezics/search-text';

diagnoseText('a|');
// {
//   reason: 'expected_operand',
//   unit: 'utf16',
//   start: 2,
//   end: 2,
//   codePointStart: 2,
//   codePointEnd: 2,
//   byteOffset: 2,
// }

parseText('a|'); // throws TextSyntaxError: unsupported, offset 2
```
