import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { facetProperties, readNativeSpoilerLevel, type FilterQualifier } from '@rezics/filter';
import type { Related, Subject } from '../../../subject/types';
import { typeExtends } from '../graph-browser';
import { bestRank, isRecord, pageText, spoilerLevel, type Stmt } from '../shared';

type Statement = SubjectRead['subject']['statements'][string][number];
export type TagDefinitions = Pick<Release, 'types' | 'properties'>;
export const workTagPreviewLimit = 24;
const weightProperty = 'rezics:sourceTagWeight';
const metricProperty = 'rezics:sourceTagWeightMetric';
const spoilerProperty = 'rezics:spoilerLevel';

export type WorkTagWeight =
  | { state: 'absent' }
  | { state: 'unsupported' }
  | { state: 'unavailable' }
  | { state: 'source'; amount: string; metric: 'vndbTagsRating' };

/** One original assertion. Neither its label nor a redirect is an association key. */
export type WorkTag = {
  property: string;
  statement: Statement;
  originalId: string;
  label: ReturnType<typeof pageText>;
  role: ReturnType<typeof pageText>;
  weight: WorkTagWeight;
  spoiler: string | undefined;
  qualifiers: FilterQualifier[];
};

export type WorkTagsReading =
  | { state: 'unsupported' }
  | { state: 'unavailable' }
  | { state: 'ready'; tags: WorkTag[]; properties: string[] };

/** Disclosure is checked before a label, weight, count, URL or evidence selection is projected. */
function tagSpoiler(statement: Stmt, threshold: number): { level?: string; qualifiers: FilterQualifier[] } | undefined {
  if (spoilerLevel(statement) > threshold) return;
  const qualifiers: FilterQualifier[] = [];
  let level: string | undefined;
  for (const part of statement.qualifiers) {
    if (part.property.id !== spoilerProperty) continue;
    const supplied = part.value.type === 'value' ? readNativeSpoilerLevel(part.value.content) : null;
    // Unknown evidence cannot be opened by raising the preference to the maximum.
    if (supplied === null || Number(supplied) > threshold) return;
    qualifiers.push({ property: part.property.id, in: [supplied] });
    if (level === undefined || Number(supplied) > Number(level)) level = supplied;
  }
  return { ...(level === undefined ? {} : { level }), qualifiers };
}

/** Read only the released typed provider aggregate. Preserve its exact decimal token. */
export function workTagWeight(statement: Stmt, definitions: TagDefinitions): WorkTagWeight {
  const weights = statement.qualifiers.filter((part) => part.property.id === weightProperty);
  const metrics = statement.qualifiers.filter((part) => part.property.id === metricProperty);
  if (!weights.length && !metrics.length) return { state: 'absent' };
  const role = definitions.properties[statement.property.id];
  const weight = definitions.properties[weightProperty];
  const metric = definitions.properties[metricProperty];
  if (
    !role?.qualifiers?.includes(weightProperty) ||
    !role.qualifiers.includes(metricProperty) ||
    weight?.datatype !== 'quantity' ||
    metric?.datatype !== 'string'
  )
    return { state: 'unsupported' };
  if (weights.length !== 1 || metrics.length !== 1) return { state: 'unavailable' };
  const suppliedWeight = weights[0]!;
  const suppliedMetric = metrics[0]!;
  if (
    suppliedWeight.property.data_type !== weight.datatype ||
    suppliedMetric.property.data_type !== metric.datatype ||
    suppliedWeight.value.type !== 'value' ||
    suppliedMetric.value.type !== 'value'
  )
    return { state: 'unavailable' };
  if (suppliedMetric.value.content !== 'vndbTagsRating') return { state: 'unsupported' };
  const content = suppliedWeight.value.content;
  if (
    !isRecord(content) ||
    typeof content.amount !== 'string' ||
    !/^\+(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(content.amount) ||
    content.unit !== '1' ||
    Object.keys(content).some((key) => key !== 'amount' && key !== 'unit')
  )
    return { state: 'unavailable' };
  // Compare decimal strings: a rounded 3.000...001 must never be reported as 3.
  const [integer, fraction = ''] = content.amount.slice(1).split('.');
  if (
    (integer === '0' && !/[1-9]/.test(fraction)) ||
    !['0', '1', '2', '3'].includes(integer!) ||
    (integer === '3' && /[1-9]/.test(fraction))
  )
    return { state: 'unavailable' };
  return { state: 'source', amount: content.amount, metric: 'vndbTagsRating' };
}

/**
 * Project the supplied current Subject page only. The native reader already selected rank/slots when it supplies
 * relationCounts. Re-ranking that truncated window would discard other admitted assertions.
 */
export function readWorkTags(
  subject: Subject,
  related: Related,
  definitions: TagDefinitions | undefined,
  locale: string,
  spoilerThreshold: number,
): WorkTagsReading {
  if (!definitions) return { state: 'unavailable' };
  if (!definitions.types[subject.type]) return { state: 'unavailable' };
  if (!typeExtends(definitions, subject.type, 'schema:CreativeWork')) return { state: 'unsupported' };
  const properties = facetProperties(definitions, [subject.type]).filter(
    (property) => definitions.properties[property]?.datatype === 'wikibase-item',
  );
  if (!properties.length) return { state: 'unsupported' };
  const tags: WorkTag[] = [];
  for (const property of properties) {
    const supplied = Object.hasOwn(subject.statements, property) ? (subject.statements[property] ?? []) : [];
    const current = subject.relationCounts ? supplied : bestRank(supplied);
    for (const statement of current as Statement[]) {
      if (
        statement.rank === 'deprecated' ||
        statement.property.id !== property ||
        statement.property.data_type !== 'wikibase-item' ||
        statement.value.type !== 'value' ||
        typeof statement.value.content !== 'string'
      )
        continue;
      const disclosure = tagSpoiler(statement, spoilerThreshold);
      if (!disclosure) continue;
      const originalId = statement.value.content;
      const summary = Object.hasOwn(related, originalId) ? related[originalId] : undefined;
      if (!summary?.type || !typeExtends(definitions, summary.type, 'skos:Concept')) continue;
      const label = pageText(summary.labels, locale);
      if (!label.text) continue;
      tags.push({
        property,
        statement,
        originalId,
        label,
        role: pageText(definitions.properties[property]?.labels, locale),
        weight: workTagWeight(statement, definitions),
        spoiler: disclosure.level,
        qualifiers: disclosure.qualifiers,
      });
    }
  }
  return { state: 'ready', tags, properties };
}
