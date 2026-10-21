import { t } from 'elysia';
import { labels, readAssessment } from '../suitability/contract.ts';
import { coverCreditSchema } from './cover-credit.ts';
import { mediaContextInput } from './context-input.ts';

export const mediaUuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const mediaNative = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const mediaType = t.Union([t.Literal('image/png'), t.Literal('image/jpeg'),
  t.Literal('image/webp'), t.Literal('image/gif')]);
const coverHolderEvidence = t.Union([t.Null(), t.Object({ name: t.String({ minLength: 1, maxLength: 200 }),
  fieldLocator: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false })]);
const importedArtFacts = {
  targetWork: mediaNative,
  source: t.Object({ record: mediaNative, component: t.Nullable(mediaNative), observation: mediaNative,
    provider: t.String({ minLength: 1, maxLength: 100 }), namespace: t.String({ minLength: 1, maxLength: 100 }),
    externalId: t.String({ minLength: 1, maxLength: 500 }), sourceRevision: t.Nullable(t.String({ maxLength: 200 })),
    observationDigest: digest, datasetSnapshotDigest: digest, recordDigest: digest,
    fieldLocator: t.String({ minLength: 1, maxLength: 500 }), displayName: t.String({ minLength: 1, maxLength: 200 }),
    href: t.String({ format: 'uri', maxLength: 2048 }), }, { additionalProperties: false }),
  image: t.Object({ captureUrl: t.String({ format: 'uri', maxLength: 2048 }), captureDigest: digest,
    byteLength: t.Integer({ minimum: 1, maximum: 8_388_608 }), mediaType }, { additionalProperties: false }),
  originalDigest: digest, holderEvidence: coverHolderEvidence,
};
export const importedArtRoleSchema = t.Union([t.Literal('cover'), t.Literal('portrait'), t.Literal('screenshot')]);
export const importedCoverIntent = t.Union([
  t.Object({ format: t.Literal('media-imported-cover-v1'), ...importedArtFacts }, { additionalProperties: false }),
  t.Object({ format: t.Literal('media-imported-art-v2'), ...importedArtFacts, role: importedArtRoleSchema,
    archive: t.Nullable(t.Object({ admission: mediaNative, coordinate: t.Object({
      table: t.Union([t.Literal('vn'), t.Literal('chars'), t.Literal('vn_screenshots'),
        t.Literal('releases_images'), t.Literal('vn_image_votes')]),
      rowOrdinal: t.Integer({ minimum: 0, maximum: 19_999_999 }), rowDigest: digest,
      fieldLocator: t.String({ minLength: 1, maxLength: 100 }), imageId: t.String({ pattern: '^(cv|ch|sf)[0-9]+$' }),
      namespace: t.Union([t.Literal('vn'), t.Literal('character'), t.Literal('release')]),
      externalId: t.String({ pattern: '^[vcr][0-9]+$' }), role: importedArtRoleSchema,
    }, { additionalProperties: false }) }, { additionalProperties: false })),
  }, { additionalProperties: false }),
]);
export const importedArtUseCommand = t.Object({ profile: t.Literal('media-imported-art-use-v2'),
  actingSubject: mediaNative, target: mediaNative, context: t.Optional(mediaContextInput),
  asset: mediaUuid, variant: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
  revision: mediaUuid, representation: mediaUuid, occurrence: mediaUuid, role: importedArtRoleSchema,
}, { additionalProperties: false });
export const imageNsfw = t.Union([t.Literal('unknown'),t.Literal('sfw'),t.Literal('nsfw')]);
const nullableHead = t.Nullable(mediaNative);
export const mediaControlBasis = t.Object({head:nullableHead,epoch:t.String({pattern:'^(0|[1-9][0-9]{0,18})$'}),protection:nullableHead},{additionalProperties:false});
const control = t.Object({target:t.Object({component:t.String(),definition:t.String(),occurrence:t.Nullable(t.String()),context:t.String()}),
  basis:mediaControlBasis,valueHead:nullableHead,locked:t.Boolean(),canEdit:t.Boolean(),canProtect:t.Boolean()},{additionalProperties:false});
export const mediaDescriptorFields = {representation:mediaUuid,asset:mediaUuid,sha256:t.String(),use:t.Nullable(mediaUuid),
  mediaType:t.String(),width:t.Integer(),height:t.Integer(),url:t.String(),nsfw:imageNsfw,
  nsfwSourceId:t.Optional(t.Nullable(mediaNative)),ageRating:readAssessment,conceal:t.Boolean(),coverCredit:coverCreditSchema,
  controls:t.Object({nsfw:control,ageRating:control,conceal:t.Nullable(control)}),canEdit:t.Boolean(),canProtect:t.Boolean()};
export const mediaDescriptor = t.Object(mediaDescriptorFields,{additionalProperties:false});
export const metadataRef = t.Union([t.Object({representation:mediaUuid,use:t.Optional(mediaUuid)},{additionalProperties:false}),
  t.Object({selection:mediaUuid},{additionalProperties:false})]);
export const metadataRead = t.Object({actingSubject:t.Optional(mediaNative),items:t.Array(metadataRef,{minItems:1,maxItems:64})},{additionalProperties:false});
export const metadataResult = t.Object({items:t.Array(t.Union([
  t.Object({status:t.Literal('available'),...mediaDescriptorFields},{additionalProperties:false}),
  t.Object({status:t.Literal('unavailable'),reference:metadataRef},{additionalProperties:false}),
]),{maxItems:64})});
const ageValue=t.Union([t.Object({status:t.Literal('unassessed')},{additionalProperties:false}),
  t.Object({status:t.Literal('assessed'),labels},{additionalProperties:false})]);
const fieldBasis={actingSubject:mediaNative,expectedValueHead:nullableHead,basis:mediaControlBasis,
  mode:t.Union([t.Literal('edit'),t.Literal('lock'),t.Literal('unlock')]),
  authority:t.Optional(t.Union([t.Literal('author'),t.Literal('platform')]))};
export const imageLabelCommand=t.Union([
  t.Object({...fieldBasis,field:t.Literal('nsfw'),value:imageNsfw},{additionalProperties:false}),
  t.Object({...fieldBasis,field:t.Literal('ageRating'),value:ageValue},{additionalProperties:false}),
]);
export const concealCommand=t.Object({...fieldBasis,value:t.Boolean()},{additionalProperties:false});
export const inferenceCommand=t.Object({actingSubject:mediaNative,sha256:t.String({pattern:'^[0-9a-f]{64}$'}),
  model:t.String({maxLength:100}),modelVersion:t.String({maxLength:100}),weightsDigest:t.String({pattern:'^[0-9a-f]{64}$'}),
  policyVersion:t.String({maxLength:100}),result:imageNsfw,status:t.Union([t.Literal('completed'),t.Literal('unavailable')]),
  scores:t.Optional(t.Object({Drawing:t.Number({minimum:0,maximum:1}),Hentai:t.Number({minimum:0,maximum:1}),
    Neutral:t.Number({minimum:0,maximum:1}),Porn:t.Number({minimum:0,maximum:1}),Sexy:t.Number({minimum:0,maximum:1})},{additionalProperties:false})),
},{additionalProperties:false});
export const documentUseCommand=t.Object({actingSubject:mediaNative,target:mediaNative,representation:mediaUuid,
  occurrence:mediaUuid,context:t.Optional(mediaContextInput),conceal:t.Optional(t.Boolean()),
  memberReplyDraft:t.Optional(t.Object({profile:t.Literal('member-reply-draft-image-v1'),
    variantId:t.String({pattern:'^urn:rezics:variant:[0-9a-f-]{36}$'}),expectedHead:mediaUuid,
    rootTarget:mediaNative,rootRevision:mediaNative},{additionalProperties:false})),
},{additionalProperties:false});
