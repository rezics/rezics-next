import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { profileSourceRecords, type ProfileBound, type ProfileSourceRecord } from '../music-reader';
import { candidateContext } from '../../../subject/candidates';
import {
  codecProperty,
  fileGroups,
  fileStreams,
  historicalStatement,
  isCatalogueFileType,
  isReleaseGroupType,
  relatedReadable,
  relatedTarget,
  selectedStatements,
  type FileStream,
} from '../catalogue-file-profile/model';
import {
  fileTypeCandidates,
  groupTypeCandidates,
  isA,
  isReleaseType,
} from '../release-fidelity/model';
import type { ProfileRelationPage } from '../../pages/views';

type Statement = SubjectRead['subject']['statements'][string][number];
type Related = SubjectRead['related'];

export type CatalogueFileFact = {
  property: string;
  label: { text: string; lang: string | null };
  statements: Statement[];
};

export type CatalogueFileAssociation = {
  key: string;
  property: string;
  direction: 'forward' | 'inverse';
  label: { text: string; lang: string | null };
  kind: FileStream['kind'];
  source: { id: string; label: string; lang?: string };
  target: { id: string; label: string; lang?: string };
  statement: Statement;
  readability: 'readable' | 'concealed' | 'unreadable';
  historical: boolean;
};

export type CatalogueFileReaderVisit = {
  state: 'loading' | 'unavailable' | 'unsupported' | 'ready' | 'empty';
  public: SubjectRead;
  locale: string;
  digest?: string;
  release?: Release;
  grain: { text: string; lang: string | null };
  groups: Record<'identifiers' | 'technical' | 'language' | 'group' | 'credits' | 'facts', CatalogueFileFact[]>;
  associations: CatalogueFileAssociation[];
  bounds: ProfileBound[];
  sources: ProfileSourceRecord[];
  unknownCodec: boolean;
  correction?: { id: string; label: string };
};

export function catalogueFileReaderCandidate(read: SubjectRead): boolean {
  const known = new Set([
    read.subject.type,
    ...(read.summary?.types ?? []),
  ]);
  return [...fileTypeCandidates, ...groupTypeCandidates].some((type) => known.has(type));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStatement(value: unknown): value is Statement {
  if (!isRecord(value) || typeof value.id !== 'string' || !['normal', 'preferred', 'deprecated'].includes(String(value.rank)))
    return false;
  if (!isRecord(value.property) || typeof value.property.id !== 'string' || typeof value.property.data_type !== 'string')
    return false;
  if (!isRecord(value.value) || !['value', 'somevalue', 'novalue'].includes(String(value.value.type))) return false;
  if (!Array.isArray(value.qualifiers) || !Array.isArray(value.references) || !isRecord(value.rezics)) return false;
  return typeof value.rezics.release === 'string' && typeof value.rezics.revision === 'number';
}

function relatedInfo(value: unknown, id: string): { type: string; labels: Record<string, string> } | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return;
  if (typeof value.id === 'string' && value.id !== id) return;
  const labels: Record<string, string> = {};
  if (isRecord(value.labels)) {
    for (const [language, label] of Object.entries(value.labels)) if (typeof label === 'string') labels[language] = label;
  }
  if (isRecord(value.label) && typeof value.label.value === 'string' && typeof value.label.language === 'string')
    labels[value.label.language] = value.label.value;
  return { type: value.type, labels };
}

function relationRelated(row: Record<string, unknown>): Related {
  const values = isRecord(row.related) ? row.related : {};
  const related: Related = {};
  for (const [id, value] of Object.entries(values)) {
    const item = relatedInfo(value, id);
    if (item) related[id] = { type: item.type, labels: item.labels };
  }
  return related;
}

function summaryOf(value: unknown): { id: string; type: string; label: string; language?: string } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return;
  let label = '';
  let language: string | undefined;
  if (isRecord(value.label) && typeof value.label.value === 'string') {
    label = value.label.value;
    if (typeof value.label.language === 'string') language = value.label.language;
  }
  return { id: value.id, type: value.type, label, ...(language ? { language } : {}) };
}

function associationKind(release: Release, type: string): FileStream['kind'] | undefined {
  if (!release.types[type]) return;
  if (type === 'schema:Episode' || isA(release, type, 'schema:Episode')) return 'episode';
  if (isReleaseType(release, type)) return 'release';
  if (isCatalogueFileType(release, type)) return 'file';
  if (isReleaseGroupType(release, type)) return 'group';
}

function factFields(
  publicRead: SubjectRead,
  release: Release,
  properties: readonly string[],
  locale: string,
): CatalogueFileFact[] {
  return properties.flatMap((property) => {
    const statements = selectedStatements(publicRead.subject.statements[property]);
    if (!statements.length) return [];
    return [{
      property,
      label: pickText(release.properties[property]?.labels ?? {}, locale),
      statements,
    }];
  });
}

function associations(
  publicRead: SubjectRead,
  release: Release,
  digest: string,
  streams: readonly FileStream[],
  pages: readonly ProfileRelationPage[],
  locale: string,
): CatalogueFileAssociation[] {
  const result: CatalogueFileAssociation[] = [];
  const title = pickText(publicRead.subject.labels, locale);
  const streamByKey = new Map(streams.map((stream) => [`${stream.direction}:${stream.property}`, stream]));
  for (const page of pages) {
    const stream = streamByKey.get(`${page.direction}:${page.property}`);
    if (!stream) continue;
    for (const [index, rawRow] of page.rows.entries()) {
      if (!isRecord(rawRow)) continue;
      const rowSummary = summaryOf(rawRow.summary);
      const related = relationRelated(rawRow);
      if (page.direction === 'inverse' && rawRow.property !== page.property) continue;
      const assertion = page.direction === 'forward' ? rawRow.statement : rawRow.assertion;
      const statement = isStatement(assertion) ? assertion : undefined;
      if (!statement || statement.property.id !== page.property) continue;
      if (page.direction === 'inverse' && rawRow.statement !== statement.id) continue;
      const relatedId = page.direction === 'forward'
        ? relatedTarget(statement)
        : typeof rawRow.subject === 'string' ? rawRow.subject : undefined;
      if (!relatedId || !rowSummary || rowSummary.id !== relatedId) continue;
      if (page.direction === 'inverse' && relatedTarget(statement) !== publicRead.subject.id) continue;
      const info = relatedInfo(related[relatedId], relatedId);
      if (!info || rowSummary.type !== info.type) continue;
      const kind = associationKind(release, info.type);
      if (!kind) continue;
      if (page.direction === 'forward') {
        const allowedTargets = release.properties[page.property]?.targets ?? [];
        if (!allowedTargets.some((target) => info.type === target || isA(release, info.type, target))) continue;
      }
      const readability = relatedReadable(related, relatedId);
      const relatedLabel = pickText(info.labels, locale);
      const historical = historicalStatement(statement, digest);
      const source = page.direction === 'forward'
        ? { id: publicRead.subject.id, label: title.text, ...(title.lang ? { lang: title.lang } : {}) }
        : { id: relatedId, label: relatedLabel.text, ...(relatedLabel.lang ? { lang: relatedLabel.lang } : {}) };
      const target = page.direction === 'forward'
        ? { id: relatedId, label: relatedLabel.text, ...(relatedLabel.lang ? { lang: relatedLabel.lang } : {}) }
        : { id: publicRead.subject.id, label: title.text, ...(title.lang ? { lang: title.lang } : {}) };
      result.push({
        key: `${page.direction}:${page.property}:${relatedId}:${statement?.id ?? index}`,
        property: page.property,
        direction: page.direction,
        label: stream.label,
        kind,
        source,
        target,
        statement,
        readability,
        historical,
      });
    }
  }
  return result;
}

export function catalogueFileReaderVisit(input: {
  locale: string;
  public: SubjectRead;
  release?: Release;
  digest?: string;
  loading?: boolean;
  unavailable?: boolean;
  unsupported?: boolean;
  allowCorrection?: boolean;
  relationPages?: readonly ProfileRelationPage[];
  bounds?: readonly ProfileBound[];
}): CatalogueFileReaderVisit {
  const emptyGroups = {
    identifiers: [],
    technical: [],
    language: [],
    group: [],
    credits: [],
    facts: [],
  } satisfies CatalogueFileReaderVisit['groups'];
  const grain = input.release?.types[input.public.subject.type]
    ? pickText(input.release.types[input.public.subject.type]!.labels, input.locale)
    : { text: input.public.subject.type, lang: null };
  const base = {
    public: input.public,
    locale: input.locale,
    ...(input.release ? { release: input.release } : {}),
    ...(input.digest ? { digest: input.digest } : {}),
    grain,
    bounds: [...(input.bounds ?? [])],
    sources: profileSourceRecords(input.public.subject),
    unknownCodec: false,
    groups: emptyGroups,
    associations: [],
  };
  if (input.loading) return { ...base, state: 'loading' };
  if (input.unsupported) return { ...base, state: 'unsupported' };
  if (input.unavailable || !input.release || !input.digest) return { ...base, state: 'unavailable' };
  const release = input.release;
  const type = input.public.subject.type;
  if (!release.types[type] || !isCatalogueFileType(release, type) && !isReleaseGroupType(release, type))
    return { ...base, state: 'unsupported' };
  const grouped = fileGroups(release, type);
  const streams = fileStreams(release, type, input.locale);
  const groups = {
    identifiers: factFields(input.public, release, grouped.identifiers, input.locale),
    technical: factFields(input.public, release, grouped.technical, input.locale),
    language: factFields(input.public, release, grouped.language, input.locale),
    group: factFields(input.public, release, grouped.group, input.locale),
    credits: factFields(input.public, release, grouped.credits, input.locale),
    facts: factFields(input.public, release, [...grouped.relations, ...grouped.facts], input.locale),
  };
  const codec = codecProperty(release, type);
  const codecSchema = codec ? release.properties[codec]?.value : undefined;
  const codecEnum = isRecord(codecSchema) && Array.isArray(codecSchema.enum)
    ? codecSchema.enum.filter((value): value is string => typeof value === 'string')
    : undefined;
  const unknownCodec = codec
    ? selectedStatements(input.public.subject.statements[codec]).some((statement) => {
        if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return false;
        return codecEnum ? !codecEnum.includes(statement.value.content) : true;
      })
    : false;
  const rows = associations(
    input.public,
    release,
    input.digest,
    streams,
    input.relationPages ?? [],
    input.locale,
  );
  const hasContent = Object.values(groups).some((items) => items.length) || rows.length || input.public.subject.sourceRecords.length;
  return {
    ...base,
    state: hasContent ? 'ready' : 'empty',
    groups,
    associations: rows,
    unknownCodec,
    ...(input.allowCorrection !== false && input.public.subject.context === candidateContext
      ? { correction: { id: input.public.subject.id, label: pickText(input.public.subject.labels, input.locale).text } }
      : {}),
  };
}

/** Exact item values keep their admitted subject identity; redirects never rewrite the destination. */
export function exactFileItem(part: Pick<Statement, 'property' | 'value'>, related: Related) {
  if (part.value.type !== 'value' || part.property.data_type !== 'wikibase-item') return;
  if (typeof part.value.content !== 'string') return;
  const item = related[part.value.content];
  if (!item || !Object.keys(item.labels).length) return;
  return { id: part.value.content, labels: item.labels };
}

export { selectedStatements };
