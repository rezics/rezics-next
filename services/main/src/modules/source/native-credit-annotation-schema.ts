import { t } from 'elysia';
import { languageTagSchema } from '../display-language/schema.ts';
import type { StaticDecode, StaticEncode } from 'typebox';
import type { NativeCreditAnnotationRequest, NativeCreditAnnotationResult } from './native-credit-annotation.ts';

const closed = { additionalProperties: false };
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const text = t.String({ minLength: 1, maxLength: 500 });
const requestSchema = t.Object({
  profile: t.Literal('source-native-credit-annotation-v1'), actingSubject: native,
  expectedAnnotation: t.Nullable(native),
  native: t.Object({ work: native, workHead: native, credit: native, revision: native,
    receipt: t.String({ pattern: '^urn:rezics:receipt:[0-9a-f]{64}$' }),
    participation: t.Object({ role: text, participant: t.Union([
      t.Object({ kind: t.Literal('resource'), ref: native }, closed),
      t.Object({ kind: t.Literal('external'), provider: text, namespace: text, key: text }, closed),
    ]), position: t.Optional(t.Integer({ minimum: 0 })) }, closed),
  }, closed),
  field: t.Union([t.Literal('creditedName'), t.Literal('provider'), t.Literal('namespace'), t.Literal('key'),
    t.Literal('alias'), t.Literal('eid'), t.Literal('note')]),
  selected: t.Object({ presence: t.Union([t.Literal('value'), t.Literal('null'), t.Literal('empty-string')]),
    value: t.Nullable(t.String({ maxLength: 16_384 })),
    language: t.Union([t.Object({ state: t.Literal('omitted') }, closed), t.Object({ state: t.Literal('null') }, closed),
      t.Object({ state: t.Literal('value'), value: languageTagSchema() }, closed)]),
  }, closed),
  source: t.Object({ record: native, observation: native, byteDigest: digest, recordDigest: digest,
    pointer: t.String({ minLength: 1, maxLength: 4096 }), valueDigest: digest,
    languagePointer: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  }, closed),
}, closed);

const resultSchema = t.Object({
  profile: t.Literal('source-native-credit-annotation-v1'), support: native,
  state: t.Union([t.Literal('recorded'), t.Literal('withdrawn'), t.Literal('superseded')]),
  receipt: t.String({ pattern: '^urn:rezics:receipt:[0-9a-f]{64}$' }), requestDigest: digest,
  request: requestSchema, createdAt: t.String(),
  headGuarantee: t.Literal('verified-before-commit'), nativeEffect: t.Literal('none'),
}, closed);

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
export type NativeCreditAnnotationSchemaProof = [
  Assert<Extends<StaticEncode<typeof requestSchema>, NativeCreditAnnotationRequest>>,
  Assert<Extends<NativeCreditAnnotationRequest, StaticEncode<typeof requestSchema>>>,
  Assert<Extends<StaticDecode<typeof requestSchema>, NativeCreditAnnotationRequest>>,
  Assert<Extends<NativeCreditAnnotationRequest, StaticDecode<typeof requestSchema>>>,
  Assert<Extends<StaticEncode<typeof resultSchema>, NativeCreditAnnotationResult>>,
  Assert<Extends<NativeCreditAnnotationResult, StaticEncode<typeof resultSchema>>>,
  Assert<Extends<StaticDecode<typeof resultSchema>, NativeCreditAnnotationResult>>,
  Assert<Extends<NativeCreditAnnotationResult, StaticDecode<typeof resultSchema>>>,
];
export const nativeCreditAnnotationRequest = t.Unsafe<NativeCreditAnnotationRequest>(requestSchema);
export const nativeCreditAnnotationResult = t.Unsafe<NativeCreditAnnotationResult>(resultSchema);
