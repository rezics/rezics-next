import { memoizedValue } from '../memoized.ts';
// Schema declarations are shared with Community without depending on Realm media commands.
import { MediaImportRequestSchema } from '@rezics/definitions/media-import';
import { t } from 'elysia';

export type RealmPresentationOptional<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'none' | 'unavailable'; value: null }>;
export type RealmPresentationImage = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly Readonly<{ format: 'avif' | 'webp'; width: number; height: number }>[];
  placeholder: Readonly<{ thumbhash: string; color: string }> | null;
  focalPoint: Readonly<{ x: number; y: number }> | null;
  credit: import('@rezics/definitions/media-import').MediaImportRequest['credit'] | null;
}>;

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullable = <T extends import('typebox').TSchema>(schema: T) => t.Union([schema, t.Null()]);
export function RealmPresentationImageSchema() {
  return memoizedValue(RealmPresentationImageSchema, () =>
    t.Object(
      {
        id,
        containerId: id,
        digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        width: t.Integer({ minimum: 1 }),
        height: t.Integer({ minimum: 1 }),
        variants: t.Array(
          t.Object(
            {
              format: t.Union([t.Literal('avif'), t.Literal('webp')]),
              width: t.Integer({ minimum: 1 }),
              height: t.Integer({ minimum: 1 }),
            },
            closed,
          ),
          { minItems: 1, maxItems: 12 },
        ),
        placeholder: nullable(t.Object({ thumbhash: t.String(), color: t.String() }, closed)),
        focalPoint: nullable(
          t.Object({ x: t.Number({ minimum: 0, maximum: 1 }), y: t.Number({ minimum: 0, maximum: 1 }) }, closed),
        ),
        credit: nullable(MediaImportRequestSchema.properties.credit),
      },
      closed,
    ),
  );
}
