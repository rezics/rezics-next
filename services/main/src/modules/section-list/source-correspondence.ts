import { isDeepStrictEqual } from 'node:util';
import { PublicationUnavailable } from '../contribution/publish.ts';
import { readSourceCorrespondenceRecords, type SourceCorrespondenceVerifier } from '../structure/source-correspondence.ts';

/** A retained section-list document describes ordered notes and exact optional references. */
export const verifySectionListSource: SourceCorrespondenceVerifier = async ({ environment, observation, header }) => {
  const refuse = () => new PublicationUnavailable('Section-list source correspondence is unavailable');
  if (observation.coverage.scope !== 'complete-section-list'
    || !/^application\/json(?:;|$)/i.test(observation.mediaType)) throw refuse();
  let document: { url: string; author: string | null; license: string | null; items: unknown[] };
  try { document = JSON.parse(Buffer.from(observation.rawBytesBase64!, 'base64').toString('utf8')); }
  catch { throw refuse(); }
  if (!document || !Array.isArray(document.items) || document.items.length > 4096) throw refuse();
  const records = await readSourceCorrespondenceRecords(environment, header, document.items.length);
  const indices = new Map(records.map((record, index) => [record.occurrence, index]));
  const actual = records.map((record, index) => {
    if (record.sourceKey !== `${observation.observation}#/items/${index}`) throw refuse();
    return { role: record.role, parent: record.parent === header.structure ? null : indices.get(record.parent),
      labels: record.labels, ...(record.target ? { target: record.target } : {}),
      ...(record.qualifier ? { qualifier: record.qualifier } : {}),
      ...(record.selection ? { selection: record.selection } : {}) };
  });
  if (!isDeepStrictEqual(actual, document.items)) throw refuse();
  return { observation: observation.observation, structure: header.structure, revision: header.head,
    attribution: { url: document.url, author: document.author, license: document.license } };
};
