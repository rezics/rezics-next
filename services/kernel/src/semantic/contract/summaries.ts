import { Type as t } from 'typebox';
import type { ContentCoverCredit } from './domain-ports.ts';

const object = { additionalProperties: false } as const;
export const CoverSummarySchema = t.Union([
  t.Object(
    {
      media: t.String({ format: 'uuid' }),
      width: t.Integer({ minimum: 1 }),
      height: t.Integer({ minimum: 1 }),
      placeholder: t.Object({ thumbhash: t.String(), color: t.String() }, object),
      variants: t.Array(
        t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer({ minimum: 1 }) }, object),
      ),
      focalPoint: t.Union([t.Object({ x: t.Number(), y: t.Number() }, object), t.Null()]),
      credit: t.Object(
        {
          rightsHolder: t.String(),
          via: t.Object({ name: t.String(), url: t.String() }, object),
          license: t.String(),
          obligations: t.Array(t.String()),
        },
        object,
      ),
    },
    object,
  ),
  t.Null(),
]);
export const SubjectSummarySchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    types: t.Array(t.String()),
    label: t.Union([t.Object({ value: t.String(), language: t.String() }, object), t.Null()]),
    creativeWork: t.Boolean(),
    cover: CoverSummarySchema,
  },
  object,
);
/** Related summaries of a merged original add the survivor it redirects to, so receiving routes can follow it. */
export const RelatedSubjectSummarySchema = t.Object(
  { ...SubjectSummarySchema.properties, redirect: t.Optional(t.String({ format: 'uuid' })) },
  object,
);

/** Disclosed display vocabulary shared by native producers and receiving transports. */
export type CoverCredit = ContentCoverCredit;
export type CoverSummary = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: ContentCoverCredit;
};
export type SubjectSummary = {
  id: string;
  type: string;
  types: string[];
  label: { value: string; language: string } | null;
  creativeWork: boolean;
  cover: CoverSummary | null;
};
/** An original retains its key while its visible survivor supplies the summary. */
export type RelatedSubjectSummary = SubjectSummary & { redirect?: string };

export type SummarySources = readonly Readonly<{ partition: number; epoch: number; position: bigint }>[];
export type SummaryCoverState = 'available' | 'absent' | 'concealed';
/** Internal composition, never a browser-supplied witness or a cached allow.
 * Each component is an independent native home position, as in Subject reads.
 */
export type SubjectSummaryObservation = Readonly<{
  summaries: ReadonlyMap<string, SubjectSummary | null>;
  covers: ReadonlyMap<string, SummaryCoverState>;
  components: SummarySources;
  current: () => Promise<boolean>;
}>;

export type PublicSummaryQuery = Readonly<{
  ids: readonly string[];
  languages: readonly string[];
  deadline: number;
}>;

export type PublicSummaryRead<Summary extends SubjectSummary = SubjectSummary> = (
  query: PublicSummaryQuery,
) => Promise<ReadonlyMap<string, Summary>>;
