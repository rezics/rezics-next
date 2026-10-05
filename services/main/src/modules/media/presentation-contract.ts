import { t } from 'elysia';
import { labels, readAssessment } from '../suitability/contract.ts';

export const mediaUuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const mediaNative = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
export const imageNsfw = t.Union([t.Literal('unknown'),t.Literal('sfw'),t.Literal('nsfw')]);
const nullableHead = t.Nullable(mediaNative);
export const mediaControlBasis = t.Object({head:nullableHead,epoch:t.String({pattern:'^(0|[1-9][0-9]{0,18})$'}),protection:nullableHead},{additionalProperties:false});
const control = t.Object({target:t.Object({component:t.String(),definition:t.String(),occurrence:t.Nullable(t.String()),context:t.String()}),
  basis:mediaControlBasis,valueHead:nullableHead,locked:t.Boolean(),canEdit:t.Boolean(),canProtect:t.Boolean()},{additionalProperties:false});
export const mediaDescriptorFields = {representation:mediaUuid,asset:mediaUuid,sha256:t.String(),use:t.Nullable(mediaUuid),
  mediaType:t.String(),width:t.Integer(),height:t.Integer(),url:t.String(),nsfw:imageNsfw,
  nsfwSourceId:t.Optional(t.Nullable(mediaNative)),ageRating:readAssessment,conceal:t.Boolean(),
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
  occurrence:mediaUuid,context:t.Optional(t.String()),conceal:t.Optional(t.Boolean())},{additionalProperties:false});
