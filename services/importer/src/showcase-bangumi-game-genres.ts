import { isDeepStrictEqual } from 'node:util';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  bangumiGameSourceGenreReference,
  bangumiGameSourceGenreScheme,
  bangumiGameSourceGenres,
} from '../../../packages/conversion/src/bangumi-game-source-genres.ts';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import type { RecordBindings } from './record-bindings.ts';
import { ImportTransportError, type ReviewedCandidatePage, type ReviewedSubjectRead } from './import-client.ts';
import type { ImportIdentifierLookup, ImportIdentifierResolution } from './importer.ts';
import { createSourceRegistration } from './source-registry.ts';
import type { ShowcaseAcknowledgement } from './showcase-manifest.ts';
import { showcaseDigest } from './showcase-manifest.ts';
import type { ReviewedCataloguePort } from './reviewed-catalogue.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const conceptLimit = 256;
const diagnosticLimit = 256;

export type BangumiGameGenreConcept = Readonly<{
  literal: string;
  id: string;
  sourceUri: string;
}>;

/** IDs are lookup hints only; the current Scheme and every used Concept are read before proposal. */
export type BangumiGameGenreBindings = Readonly<{
  schemeId: string;
  schemeUri: typeof bangumiGameSourceGenreScheme;
  concepts: readonly BangumiGameGenreConcept[];
}>;

export type BangumiGameGenreDiagnostic = Readonly<{
  sourceKey: string;
  path: string;
  code:
    | 'source-field-unsupported'
    | 'missing-binding'
    | 'wrong-scheme'
    | 'retracted-binding'
    | 'refused-binding'
    | 'concealed-binding'
    | 'binding-unavailable'
    | 'source-claim-unavailable'
    | 'candidate-unavailable'
    | 'candidate-not-current';
}>;

export type BangumiGameGenrePublication = Readonly<{
  acknowledgements: readonly ShowcaseAcknowledgement[];
  candidateIds: readonly string[];
  ownerKeys: readonly string[];
  diagnostics: readonly BangumiGameGenreDiagnostic[];
}>;

/** Preserve independent Bangumi lookups while retaining only the properties an unavailable lookup owns. */
export function composeBangumiImportIdentifierLookups(
  ...lookups: readonly ImportIdentifierLookup[]
): ImportIdentifierLookup {
  return {
    async resolve(input) {
      const results = await Promise.all(lookups.map((lookup) => lookup.resolve(input)));
      const resolvedReferences: Record<string, string> = {};
      const preserveProperties = new Set<string>();
      let unavailable = false;
      for (const result of results) {
        if ('status' in result && result.status === 'unavailable') {
          unavailable = true;
          for (const property of result.preserveProperties) preserveProperties.add(property);
          Object.assign(resolvedReferences, result.resolvedReferences ?? {});
        } else Object.assign(resolvedReferences, result);
      }
      return unavailable
        ? {
            status: 'unavailable' as const,
            preserveProperties: [...preserveProperties],
            ...(Object.keys(resolvedReferences).length ? { resolvedReferences } : {}),
          }
        : resolvedReferences;
    },
  };
}

type CurrentCandidate = Extract<ReviewedCandidatePage['candidates'][number], { statement: unknown }>;
type CurrentSubject = {
  id: string;
  type: string;
  context: string;
  statements: Record<string, readonly { value?: { type?: string; content?: unknown } }[]>;
};
type BindingState =
  | { state: 'bound'; binding: BangumiGameGenreConcept }
  | { state: 'missing' | 'wrong-scheme' | 'retracted-binding' | 'refused-binding' | 'concealed-binding' | 'binding-unavailable' };

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseBangumiGameGenreBindings(value: unknown): BangumiGameGenreBindings {
  const input = object(value);
  const schemeId = input?.schemeId;
  const schemeUri = input?.schemeUri;
  const rows = input?.concepts;
  ensure(
    typeof schemeId === 'string' && uuid.test(schemeId) && schemeUri === bangumiGameSourceGenreScheme,
    'Invalid Bangumi Game genre Scheme binding',
  );
  ensure(Array.isArray(rows) && rows.length <= conceptLimit, 'Bangumi Game genre bindings exceed their concept cap');
  const literals = new Set<string>();
  const ids = new Set<string>();
  const concepts: BangumiGameGenreConcept[] = [];
  for (const value of rows) {
    const row = object(value);
    const literal = row?.literal;
    const id = row?.id;
    const sourceUri = row?.sourceUri;
    ensure(
      typeof literal === 'string' &&
        literal.length > 0 &&
        literal.length <= 200 &&
        literal.isWellFormed() &&
        !/[\u0000-\u001f\u007f]/u.test(literal) &&
        typeof id === 'string' &&
        uuid.test(id) &&
        publicUrl(sourceUri) &&
        !literals.has(literal) &&
        !ids.has(id),
      'Invalid or duplicate Bangumi Game genre Concept binding',
    );
    literals.add(literal);
    ids.add(id);
    concepts.push({ literal, id, sourceUri });
  }
  return { schemeId, schemeUri, concepts };
}

function currentSubject(read: ReviewedSubjectRead, id: string): CurrentSubject | null {
  const subject = (read as { subject?: unknown }).subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return null;
  const candidate = subject as Record<string, unknown>;
  if (
    candidate.id !== id ||
    typeof candidate.type !== 'string' ||
    candidate.context !== globalContext ||
    !object(candidate.statements)
  )
    return null;
  return candidate as unknown as CurrentSubject;
}

function hasCurrentValue(subject: CurrentSubject, property: string, content: string): boolean {
  const values = subject.statements[property];
  return (
    Array.isArray(values) &&
    values.some((statement) => statement.value?.type === 'value' && statement.value.content === content)
  );
}

function failure(error: unknown): BindingState['state'] {
  if (error instanceof ImportTransportError) {
    if (error.status === 403) return 'concealed-binding';
    if (error.status === 404) return 'retracted-binding';
    return 'binding-unavailable';
  }
  if (error instanceof TypeError) return 'binding-unavailable';
  throw error;
}

function uniqueDiagnostics(rows: readonly BangumiGameGenreDiagnostic[]): BangumiGameGenreDiagnostic[] {
  const result = new Map<string, BangumiGameGenreDiagnostic>();
  for (const row of rows) result.set(`${row.sourceKey}\0${row.path}`, row);
  return [...result.values()]
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey) || left.path.localeCompare(right.path))
    .slice(0, diagnosticLimit);
}

function diagnostic(
  sourceKey: string,
  path: string,
  code: BangumiGameGenreDiagnostic['code'],
): BangumiGameGenreDiagnostic {
  return { sourceKey, path, code };
}

export function createShowcaseBangumiGameGenreLookup(
  sourceAlias: string,
  profile: BangumiGameGenreBindings | undefined,
  port: Pick<ReviewedCataloguePort, 'readReviewedSubject' | 'reviewedCandidates'>,
): {
  lookup: ImportIdentifierLookup;
  diagnostics: () => readonly BangumiGameGenreDiagnostic[];
  bindingFor: (literal: string) => BangumiGameGenreConcept | undefined;
} {
  const diagnosticsByOccurrence = new Map<string, BangumiGameGenreDiagnostic>();
  const currentReads = new Map<string, Promise<{ subject: CurrentSubject | null } | { error: unknown }>>();
  const associationReads = new Map<string, Promise<{ page: ReviewedCandidatePage } | { error: unknown }>>();
  const verified = new Map<string, BangumiGameGenreConcept>();

  const read = (id: string) => {
    let pending = currentReads.get(id);
    if (!pending) {
      pending = port.readReviewedSubject(id).then(
        (result) => ({ subject: currentSubject(result, id) }),
        (error) => ({ error }),
      );
      currentReads.set(id, pending);
    }
    return pending;
  };

  async function missingAssociation(
    id: string,
    property: string,
    value: string,
  ): Promise<BindingState['state']> {
    const key = `${id}\0${property}\0${value}`;
    let pending = associationReads.get(key);
    if (!pending) {
      pending = port.reviewedCandidates(id, { property, target: value, context: globalContext, limit: 100 }).then(
        (page) => ({ page }),
        (error) => ({ error }),
      );
      associationReads.set(key, pending);
    }
    const read = await pending;
    if ('error' in read) return failure(read.error);
    if (read.page.next !== null) return 'binding-unavailable';
    const exact = read.page.candidates.filter(
      (candidate) =>
        'statement' in candidate &&
        candidate.statement.value.type === 'value' &&
        candidate.statement.value.content === value,
    );
    if (exact.some((candidate) => 'decision' in candidate && candidate.decision === 'rejected'))
      return 'refused-binding';
    return 'retracted-binding';
  }

  async function inspect(binding: BangumiGameGenreConcept): Promise<BindingState> {
    if (!profile) return { state: 'missing' };
    const schemeRead = await read(profile.schemeId);
    if ('error' in schemeRead) return { state: failure(schemeRead.error) };
    const scheme = schemeRead.subject;
    if (!scheme)
      return { state: await missingAssociation(profile.schemeId, 'schema:url', bangumiGameSourceGenreScheme) };
    if (scheme.type !== 'skos:ConceptScheme') return { state: 'wrong-scheme' };
    if (!hasCurrentValue(scheme, 'schema:url', bangumiGameSourceGenreScheme)) {
      if ((scheme.statements['schema:url'] ?? []).length) return { state: 'wrong-scheme' };
      return {
        state: await missingAssociation(profile.schemeId, 'schema:url', bangumiGameSourceGenreScheme),
      };
    }

    const conceptRead = await read(binding.id);
    if ('error' in conceptRead) return { state: failure(conceptRead.error) };
    const concept = conceptRead.subject;
    if (!concept)
      return { state: await missingAssociation(binding.id, 'schema:url', binding.sourceUri) };
    if (concept.type !== 'skos:Concept') return { state: 'wrong-scheme' };
    if (!hasCurrentValue(concept, 'skos:inScheme', profile.schemeId)) {
      if ((concept.statements['skos:inScheme'] ?? []).length) return { state: 'wrong-scheme' };
      return { state: await missingAssociation(binding.id, 'skos:inScheme', profile.schemeId) };
    }
    if (!hasCurrentValue(concept, 'schema:url', binding.sourceUri))
      return { state: await missingAssociation(binding.id, 'schema:url', binding.sourceUri) };
    return { state: 'bound', binding };
  }

  const lookup: ImportIdentifierLookup = {
    async resolve({ owner, conversion, signal }) {
      if (owner.source !== sourceAlias || conversion.source !== 'bangumi') return {};
      const record = conversion.normalized as { type?: unknown; infobox?: unknown };
      if (record.type !== 4 || typeof record.infobox !== 'string') return {};
      const mapping = bangumiGameSourceGenres({ type: 4, infobox: record.infobox });
      for (const item of mapping.diagnostics)
        diagnosticsByOccurrence.set(
          `${owner.external_id}\0${item.pointer}`,
          diagnostic(owner.external_id, item.pointer, 'source-field-unsupported'),
        );
      if (!mapping.requirements.length) return {};

      const references: Record<string, string> = {};
      let unavailable = false;
      for (const requirement of mapping.requirements) {
        const key = `${owner.external_id}\0${requirement.pointer}`;
        const binding = profile?.concepts.find((item) => item.literal === requirement.literal);
        if (!binding) {
          diagnosticsByOccurrence.set(key, diagnostic(owner.external_id, requirement.pointer, 'missing-binding'));
          continue;
        }
        const result = await inspect(binding);
        if (result.state === 'bound') {
          verified.set(binding.literal, binding);
          references[bangumiGameSourceGenreReference(binding.literal)] = binding.id;
          diagnosticsByOccurrence.delete(key);
        } else {
          diagnosticsByOccurrence.set(key, diagnostic(owner.external_id, requirement.pointer, result.state));
          if (result.state === 'binding-unavailable') unavailable = true;
        }
      }
      signal?.throwIfAborted();
      if (unavailable)
        return { status: 'unavailable', preserveProperties: ['schema:genre'] } satisfies ImportIdentifierResolution;
      return references;
    },
  };
  return {
    lookup,
    diagnostics: () => uniqueDiagnostics([...diagnosticsByOccurrence.values()]),
    bindingFor: (literal) => verified.get(literal),
  };
}

type SourceRecord = Readonly<{ key: string; revision: string | null; payload: Record<string, unknown> }>;

export async function prepareShowcaseBangumiGameGenres(input: {
  sourceAlias: string;
  records: readonly SourceRecord[];
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>;
  port: ReviewedCataloguePort;
  adapter: ReturnType<typeof createShowcaseBangumiGameGenreLookup>;
  lookupDiagnostics: readonly BangumiGameGenreDiagnostic[];
}): Promise<BangumiGameGenrePublication> {
  const gameRecords = input.records.filter((row) => {
    const type = row.payload.type;
    return type === 4 && typeof row.payload.infobox === 'string';
  });
  const ownerKeys = gameRecords.map((row) => row.key);
  const diagnostics = new Map(
    uniqueDiagnostics(input.lookupDiagnostics).map((item) => [`${item.sourceKey}\0${item.path}`, item]),
  );
  const acknowledgements: ShowcaseAcknowledgement[] = [];
  const registration = createSourceRegistration('bangumi', {
    source: input.sourceAlias,
    converterRevision: entityRevision,
  });

  for (const row of gameRecords) {
    const mapping = bangumiGameSourceGenres({ type: 4, infobox: String(row.payload.infobox) });
    if (!mapping.requirements.length) continue;
    const owner = { source: input.sourceAlias, external_id: row.key };
    const claim = input.bindings.claim(owner);
    if (claim?.state !== 'bound' || !uuid.test(claim.subject)) {
      diagnostics.set(`${row.key}\0/claim`, diagnostic(row.key, '/claim', 'source-claim-unavailable'));
      continue;
    }
    const resolvedReferences: Record<string, string> = {};
    for (const requirement of mapping.requirements) {
      const binding = input.adapter.bindingFor(requirement.literal);
      if (binding) resolvedReferences[bangumiGameSourceGenreReference(requirement.literal)] = binding.id;
    }
    const conversion = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: input.sourceAlias, subjectId: claim.subject, resolvedReferences },
    );
    const proposals = conversion.proposals.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    if (!proposals.length) continue;
    const local = input.bindings.candidates(owner, 'facts', { limit: 100 });
    let page: ReviewedCandidatePage;
    try {
      page = await input.port.reviewedCandidates(claim.subject, {
        property: 'schema:genre',
        context: globalContext,
        limit: 100,
      });
    } catch (error) {
      if (error instanceof ImportTransportError || error instanceof TypeError) {
        diagnostics.set(`${row.key}\0/candidate`, diagnostic(row.key, '/candidate', 'candidate-unavailable'));
        continue;
      }
      throw error;
    }
    if (page.next !== null) {
      diagnostics.set(`${row.key}\0/candidate`, diagnostic(row.key, '/candidate', 'candidate-unavailable'));
      continue;
    }
    for (const proposal of proposals) {
      const exact = local.flatMap((candidate) => {
        if (candidate.subject !== claim.subject) return [];
        try {
          const command = (JSON.parse(candidate.bytes) as { commands?: BatchCommand[] }).commands?.[0];
          return command?.op === 'propose' &&
            command.key === proposal.key &&
            isDeepStrictEqual(command.source, proposal.source) &&
            isDeepStrictEqual(command.statement, proposal.statement)
            ? [{ candidate, command }]
            : [];
        } catch {
          return [];
        }
      });
      const live = page.candidates.filter(
        (candidate): candidate is CurrentCandidate =>
          'statement' in candidate &&
          exact.some((entry) => entry.candidate.candidate === candidate.id) &&
          isDeepStrictEqual(candidate.source, proposal.source) &&
          isDeepStrictEqual(candidate.statement, proposal.statement) &&
          candidate.retracted === null &&
          candidate.retraction === null &&
          candidate.decision !== 'rejected' &&
          candidate.rank !== 'deprecated',
      );
      if (live.length !== 1) {
        const path = mapping.requirements.find(
          (item) =>
            proposal.statement.value.type === 'value' &&
            input.adapter.bindingFor(item.literal)?.id === proposal.statement.value.content,
        )?.pointer;
        diagnostics.set(`${row.key}\0${path ?? '/candidate'}`, diagnostic(row.key, path ?? '/candidate', 'candidate-not-current'));
        continue;
      }
      const owned = exact.find((entry) => entry.candidate.candidate === live[0]!.id)!;
      acknowledgements.push({
        command: owned.command,
        subjectId: claim.subject,
        candidateId: live[0]!.id,
        commandDigest: showcaseDigest(owned.command),
      });
      for (const requirement of mapping.requirements)
        if (proposal.statement.value.type === 'value' && proposal.statement.value.content === input.adapter.bindingFor(requirement.literal)?.id)
          diagnostics.delete(`${row.key}\0${requirement.pointer}`);
    }
  }

  return {
    acknowledgements,
    candidateIds: [...new Set(acknowledgements.map((ack) => ack.candidateId!).filter(Boolean))].sort(),
    ownerKeys,
    diagnostics: uniqueDiagnostics([...diagnostics.values()]),
  };
}
