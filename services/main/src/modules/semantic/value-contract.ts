import { t } from 'elysia';
import type { SemanticValue } from './value.ts';
import { EXACT_LIMITS } from './value.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const slug = t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 });
const iri = t.String({ pattern: '^https?://[^\\s<>"{}|\\\\^`]+$', maxLength: 2048 });
const key = t.String({ minLength: 1, maxLength: EXACT_LIMITS.key, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const exactLanguage = t.String({ minLength: 2, maxLength: 35 });
const resource = t.Object({ kind: t.Literal('resource'), ref: id }, closed);
const external = t.Object({ kind: t.Literal('external'), provider: slug, namespace: slug, key }, closed);
export const semanticParticipantSchema = t.Union([resource, external]);
const numberLexical = t.String({ minLength: 1, maxLength: EXACT_LIMITS.digits + 2 });
const exactNumber = t.Union([
  t.Object({ kind: t.Literal('integer'), lexical: numberLexical }, closed),
  t.Object({ kind: t.Literal('decimal'), lexical: numberLexical }, closed),
  t.Object({ kind: t.Literal('rational'), lexical: numberLexical }, closed),
]);
// Transport alternatives use the exact Value owner's codec during admission;
// JSON schema alone cannot prove canonical rational/temporal/quantity meaning.
export const semanticValueSchema = t.Unsafe<SemanticValue>(t.Union([
  exactNumber, resource, external,
  t.Object({ kind: t.Literal('boolean'), lexical: t.Union([t.Literal('true'), t.Literal('false')]) }, closed),
  t.Object({ kind: t.Literal('string'), lexical: t.String({ maxLength: EXACT_LIMITS.text }) }, closed),
  t.Object({ kind: t.Literal('language-string'), lexical: t.String({ maxLength: EXACT_LIMITS.text }),
    language: exactLanguage, direction: t.Optional(t.Union([t.Literal('ltr'), t.Literal('rtl')])) }, closed),
  t.Object({ kind: t.Literal('temporal'), lexical: t.String({ minLength: 1, maxLength: 64 }),
    precision: t.Union([t.Literal('year'), t.Literal('month'), t.Literal('day'), t.Literal('hour'),
      t.Literal('minute'), t.Literal('second')]), calendar: t.Literal('gregorian'),
    timeZone: t.Optional(t.String({ maxLength: 64 })) }, closed),
  t.Object({ kind: t.Literal('quantity'), lexical: numberLexical, value: exactNumber, unit: iri,
    quantityKind: t.Optional(iri), uncertainty: t.Optional(exactNumber) }, closed),
  t.Object({ kind: t.Literal('unknown') }, closed), t.Object({ kind: t.Literal('no-value') }, closed),
]));
