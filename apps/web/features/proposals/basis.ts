import { createHash } from 'node:crypto';
import { settle } from '../feed/types.ts';
import { type CorrectionBasis, GLOBAL_CONTEXT, type HeaderState, type Loaded, type MainClient } from './types.ts';

/**
 * The component a Work's header lives in. Main derives it from the Work's IRI
 * (`metadataComponent`, `services/main/src/modules/work/metadata-schema.ts`); a
 * proposal names it in its base heads. A drift would show as Main's typed
 * `stale_base` refusal, never as a wrong write.
 */
export const headerComponent = (work: string) => `urn:rezics:work-metadata:${
  createHash('sha256').update(`${work}\0header`).digest('hex')}`;

/**
 * What a correction of a Work's header is written against: the Work's exact
 * revision, the header's head, and the header as it stands (the editor starts
 * from it). Null when Main does not answer either read.
 */
export async function readCorrectionBasis(main: MainClient, work: string, actingSubject: string | undefined):
  Promise<Loaded<CorrectionBasis>> {
  const query = { ...actingSubject ? { actingSubject } : {} };
  const [header, metadata] = await Promise.all([settle(() => main.v1.works({ id: work }).get({ query })),
    settle(() => main.v1.works({ id: work }).metadata.get({ query }))]);
  if (!header.ok) return header;
  if (!metadata.ok) return metadata;
  const resource = header.data.id;
  const state: HeaderState = { kind: 'header', originalTitle: metadata.data.originalTitle
    ? { value: metadata.data.originalTitle.value, language: metadata.data.originalTitle.language } : null,
  completionStatus: metadata.data.completionStatus ?? null,
  localized: metadata.data.localized.map(row => ({ language: row.language, title: row.title,
    description: row.description, mainVersionLabel: row.mainVersionLabel, tagline: row.tagline ?? null })) };
  return { ok: true, data: { target: { resource, revision: header.data.revision, context: GLOBAL_CONTEXT },
    baseHeads: [{ component: headerComponent(resource), head: metadata.data.revision }], state,
    name: { value: header.data.title.value, language: header.data.title.language } } };
}
