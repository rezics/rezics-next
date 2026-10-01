import { settle } from '../feed/types.ts';
import { readHeaderState } from './read.ts';
import { type CorrectionBasis, GLOBAL_CONTEXT, type Loaded, type MainClient } from './types.ts';

/**
 * The component a Work's header lives in. Main derives it from the Work's IRI
 * (`metadataComponent`, `services/main/src/modules/work/metadata-schema.ts`); a
 * proposal names it in its base heads. A drift would show as Main's typed
 * `stale_base` refusal, never as a wrong write.
 */
export async function headerComponent(work: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${work}\0header`));
  return `urn:rezics:work-metadata:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What a correction of a Work's header is written against: the Work's exact
 * revision, the header's head, and the header as it stands (the editor starts
 * from it). Null when Main does not answer either read.
 */
export async function readCorrectionBasis(main: MainClient, work: string, actingSubject: string | undefined):
  Promise<Loaded<CorrectionBasis>> {
  const query = { ...actingSubject ? { actingSubject } : {} };
  const [header, metadata] = await Promise.all([settle(() => main.v1.works({ id: work }).get({ query })),
    readHeaderState(main, work, actingSubject)]);
  if (!header.ok) return header;
  if (!metadata.ok) return metadata;
  const resource = header.data.id;
  return { ok: true, data: { target: { resource, revision: header.data.revision, context: GLOBAL_CONTEXT },
    baseHeads: [{ component: await headerComponent(resource), head: metadata.data.head }], state: metadata.data.state,
    name: { value: header.data.title.value, language: header.data.title.language } } };
}
