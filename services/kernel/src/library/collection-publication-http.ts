/** Transport declarations for whole-query publication; selected-set publication is separate. */
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { CollectionPublicationEpisode } from './collection-publication-episode-contract.ts';

const closed = { additionalProperties: false } as const;
const visibility = t.Union([t.Literal('public'), t.Literal('unlisted')]);
const id = t.String({ format: 'uuid' });

/** Logical built-ins have revision zero before their owning command materializes them. */
export const collectionPublishQueryRequestSchema = t.Object(
  {
    revision: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    visibility,
  },
  closed,
);
export type CollectionPublishQueryRequest = Static<typeof collectionPublishQueryRequestSchema>;

const statusFields = { id, collectionId: id, visibility };
/** A completed native generation is addressed within the Collection named by this status.
 * No native evidence, working generation, previous selected output or private counts cross HTTP.
 */
export const collectionPublicationStatusSchema = t.Union([
  t.Object(
    {
      ...statusFields,
      phase: t.Union([t.Literal('staging'), t.Literal('awaiting_activation'), t.Literal('refused')]),
    },
    closed,
  ),
  t.Object(
    {
      ...statusFields,
      phase: t.Literal('complete'),
      publication: t.Object({ generation: id }, closed),
    },
    closed,
  ),
]);
export type CollectionPublicationStatus = Static<typeof collectionPublicationStatusSchema>;

/** Call only after the native reader's current owner/private-family admission.
 * This projection grants no authority and does not establish native completion. The native
 * creation receipt, including durableInitiator, remains intact for the domain reader.
 */
export function collectionPublicationStatus(episode: CollectionPublicationEpisode): CollectionPublicationStatus {
  const status = {
    id: episode.source.locator.publicationId,
    collectionId: episode.source.target.collectionId,
    visibility: episode.source.target.visibility,
  };
  return episode.phase === 'complete'
    ? { ...status, phase: 'complete', publication: { generation: episode.output.publication.generation } }
    : { ...status, phase: episode.phase };
}
