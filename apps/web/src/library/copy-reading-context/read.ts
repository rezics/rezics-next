import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '../../subject/definitions';
import { relationDefinitions } from '../../subject/relations';
import type { LibrarySubject } from '../reads';
import { copiesSubjectId } from '../copies-query';
import type { CopyReadingContext, CopyReadingContexts, CopyReadingFact, CopyReadingIdentity } from './types';

const workProperty = 'schema:exampleOfWork';
const creatorProperties = ['schema:creator', 'schema:author'];
const literalProperties = [
  { id: 'schema:bookFormat', datatype: 'string' },
  { id: 'schema:inLanguage', datatype: 'string' },
  { id: 'schema:datePublished', datatype: 'time' },
] as const;
const workTargetLimit = 2;
const creatorTargetLimit = 2;
const readConcurrency = 8;

function selectedLabel(
  labels: Record<string, string>,
  locale: string,
): Pick<CopyReadingIdentity, 'label' | 'labelLanguage'> | undefined {
  const baseLanguage = locale.split('-')[0];
  const language = [locale, ...(baseLanguage ? [baseLanguage] : []), 'en'].find((candidate) => !!labels[candidate]);
  if (!language) return;
  const label = labels[language];
  return label ? { label, labelLanguage: language } : undefined;
}

function identityFromSummary(read: SubjectRead | null, id: string, locale: string): CopyReadingIdentity | undefined {
  const summary = read?.related[id];
  if (!summary) return;
  const identity = selectedLabel(summary.labels, locale);
  return identity ? { ...identity, id } : undefined;
}

function identityFromLibrarySubject(subject: LibrarySubject): CopyReadingIdentity | undefined {
  const label = typeof subject.label === 'string' ? subject.label : subject.label.value;
  if (!label) return;
  return {
    id: subject.id,
    label,
    ...(typeof subject.label === 'string' ? {} : { labelLanguage: subject.label.language }),
  };
}

function activeStatements(read: SubjectRead, property: string) {
  return (read.subject.statements[property] ?? []).filter((statement) => statement.rank !== 'deprecated');
}

function stringValues(read: SubjectRead, property: string, datatype: string): string[] {
  const definition = read.subject.statements[property]?.[0]?.property;
  if (definition?.data_type !== datatype) return [];
  return activeStatements(read, property).flatMap((statement) => {
    if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return [];
    const value = statement.value.content.trim();
    return value && value.length <= 200 ? [value] : [];
  });
}

function relatedIds(read: SubjectRead, property: string, limit: number): string[] {
  return [...new Set(activeStatements(read, property).flatMap((statement) => {
    if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return [];
    const id = copiesSubjectId(statement.value.content);
    return id ? [id] : [];
  }))].slice(0, limit);
}

async function readSubject(
  client: KernelClient,
  id: string,
  authorization: string,
  locale: string,
): Promise<SubjectRead | null> {
  try {
    const result = await client.subjects({ id }).get({
      query: { language: locale },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return !result.error && result.data?.subject?.id === id ? result.data : null;
  } catch {
    return null;
  }
}

async function readBounded<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += readConcurrency) {
    result.push(...(await Promise.all(items.slice(offset, offset + readConcurrency).map(read))));
  }
  return result;
}

function labelsFor(release: Pick<Release, 'properties'>, properties: Iterable<string>, locale: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(relationDefinitions(release, properties, locale))
      .flatMap(([id, definition]) => definition.label ? [[id, definition.label] as const] : []),
  );
}

function emptyContext(): CopyReadingContext {
  return { association: 'unavailable', work: [], facts: [] };
}

/** Read only the visible copy subjects and their admitted, one-hop work/creator targets. */
export async function readCopyReadingContexts(
  client: KernelClient,
  subjects: readonly LibrarySubject[],
  authorization: string | null,
  release: Pick<Release, 'properties'>,
  locale: string,
): Promise<CopyReadingContexts> {
  const uniqueSubjects = [...new Map(subjects.filter((subject) => copiesSubjectId(subject.id)).map((subject) => [subject.id, subject])).values()];
  if (!authorization || uniqueSubjects.length === 0) return {};

  const subjectReads = await readBounded(uniqueSubjects, (subject) =>
    readSubject(client, subject.id, authorization, locale),
  );
  const bySubject = new Map(uniqueSubjects.map((subject, index) => [subject.id, subjectReads[index] ?? null]));
  const workDefinition = release.properties[workProperty];
  const workIsAdmitted = workDefinition?.datatype === 'wikibase-item' &&
    workDefinition.relation?.group === 'derivation';
  const creatorIds = creatorProperties.filter((property) => {
    const definition = release.properties[property];
    return definition?.datatype === 'wikibase-item' && definition.relation?.group === 'credit';
  });
  const propertyIds = [workProperty, ...creatorIds, ...literalProperties.map(({ id }) => id)];
  const propertyLabels = labelsFor(release, propertyIds, locale);
  const result: CopyReadingContexts = {};

  for (const selected of uniqueSubjects) {
    const read = bySubject.get(selected.id);
    if (!read) {
      result[selected.id] = emptyContext();
      continue;
    }
    const relation = workIsAdmitted ? activeStatements(read, workProperty) : [];
    const workIdsWithOverflow = workIsAdmitted ? relatedIds(read, workProperty, workTargetLimit + 1) : [];
    const workIds = workIdsWithOverflow.slice(0, workTargetLimit);
    const work = workIds.flatMap((id) => {
      const identity = identityFromSummary(read, id, locale);
      return identity ? [identity] : [];
    });
    const edition = relation.length ? identityFromLibrarySubject(selected) : undefined;
    const facts: CopyReadingFact[] = [];

    for (const property of creatorIds) {
      const label = propertyLabels[property];
      if (!label) continue;
      for (const id of relatedIds(read, property, creatorTargetLimit)) {
        const subject = identityFromSummary(read, id, locale);
        if (subject) facts.push({ label, subject });
      }
    }
    for (const property of literalProperties) {
      const definition = release.properties[property.id];
      const label = propertyLabels[property.id];
      if (!label || definition?.datatype !== property.datatype) continue;
      for (const value of stringValues(read, property.id, property.datatype)) {
        facts.push({ label, value });
      }
    }

    const hasEveryWorkLabel = workIdsWithOverflow.length > 0 &&
      workIdsWithOverflow.length <= workTargetLimit &&
      work.length === workIdsWithOverflow.length;
    result[selected.id] = {
      association: relation.length > 0 && hasEveryWorkLabel ? 'available' : 'unavailable',
      work,
      ...(edition ? { edition } : {}),
      facts,
    };
  }
  return result;
}
