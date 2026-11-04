import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
} from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings, SourceVocabularyGap, SourceVocabularyRequest } from '@rezics/conversion';
import { sourceVocabularyLimits } from '@rezics/conversion/source-vocabulary';
import { vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import { mapVndbVocabulary } from '@rezics/conversion/vndb-vocabulary';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import type { ImporterOptions } from './importer.ts';
import { captureShowcaseCommands, ShowcaseJournal, type ShowcasePublicationResult } from './showcase-publication.ts';
import {
  showcaseDigest,
  showcaseLimits,
  showcaseSourceMatches,
  showcaseVocabularyExternalId,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  creditTypeTaxonomy,
  readCreditTypeBindingsDetailed,
  staffCreditVocabularyAdmission,
  vndbStaffCreditConverterRevision,
  type VndbCreditVocabularyReadFailure,
  type VndbStaffCredit,
} from './vndb-staff-credits.ts';

type Row = Record<string, unknown>;
type VocabularyCommand = Extract<BatchCommand, { op: 'create' | 'propose' }>;
type Admission = NonNullable<ImporterOptions['vocabularyAdmission']>;
type AdmissionContext = Parameters<NonNullable<Admission['request']>>[0];

export type VndbCreditVocabularyReferences = Readonly<{
  schemeId: string;
  concepts: readonly { code: string; id: string }[];
}>;

export type VndbCreditVocabularyRequirement = Readonly<{
  taxonomy: typeof creditTypeTaxonomy;
  code: string;
  schemeUri: typeof creditTypeSchemeUri;
  conceptUri: string;
  sourcePath: string;
}>;

export type VndbCreditVocabularyDeliveryIssue = Readonly<{
  sourceKey: string;
  operation: 'create' | 'propose';
  outcome: 'refused' | 'unavailable';
  status: number;
}>;

export type ShowcaseVndbCredits = {
  credits: VndbStaffCredit[];
  requirements: VndbCreditVocabularyRequirement[];
  diagnostics: SourceVocabularyGap[];
  vocabularyUnavailable: VndbCreditVocabularyReadFailure[];
  vocabularyAdmission: Admission;
  deliveryEdges(edges: CrossMediaPlan['edges']): CrossMediaPlan['edges'];
};

const emptyBindings: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CREDIT_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const SOURCE_PATH = /^\/[A-Za-z0-9_./~\-]+$/u;
const DIAGNOSTIC_LIMIT = sourceVocabularyLimits.gaps;

function object(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceText(row: Row, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validSpelling(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && value.length <= 1500;
}

function edgePath(table: 'vn_staff' | 'vn_seiyuu', row: Row): string | undefined {
  const vn = sourceText(row, 'id');
  const alias = sourceText(row, 'aid');
  const endpoint = sourceText(row, table === 'vn_staff' ? 'role' : 'cid');
  const path = vn && alias && endpoint ? `/${table}/${vn}/${alias}/${endpoint}` : undefined;
  return path && path.length <= 180 && SOURCE_PATH.test(path) ? path : undefined;
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 64 &&
    value.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : undefined;
}

function gap(path: string, reason: SourceVocabularyGap['reason'], code?: string): SourceVocabularyGap {
  return {
    provider: 'vndb',
    path,
    ...(code === undefined ? {} : { code }),
    reason,
    ...(reason === 'missing_scheme' || reason === 'missing_concept'
      ? { property: reason === 'missing_scheme' ? creditTypeSchemeUri : creditTypeTaxonomy }
      : {}),
  };
}

function creditRequirements(
  credits: readonly VndbStaffCredit[],
  diagnostics: SourceVocabularyGap[],
): VndbCreditVocabularyRequirement[] {
  const firstPath = new Map<string, string>();
  for (const credit of credits) {
    if (credit.kind === 'staff' && credit.role && CREDIT_CODE.test(credit.role) && !firstPath.has(credit.role))
      firstPath.set(credit.role, credit.sourcePath);
  }
  const selected: VndbCreditVocabularyRequirement[] = [];
  const limit = Math.min(sourceVocabularyLimits.concepts, showcaseLimits.vocabulary - 1);
  for (const [code, sourcePath] of [...firstPath].sort(([a], [b]) => a.localeCompare(b))) {
    if (selected.length >= limit) {
      if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(gap(sourcePath, 'command_limit', code));
      continue;
    }
    selected.push({
      taxonomy: creditTypeTaxonomy,
      code,
      schemeUri: creditTypeSchemeUri,
      conceptUri: creditTypeConceptUri(code),
      sourcePath,
    });
  }
  return selected;
}

function vocabularySource(sourceKey: string, uri: string) {
  return sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(sourceKey),
      record_revision: null,
      converter_revision: vndbStaffCreditConverterRevision,
      digest: sourceDigest({ sourceKey, uri, converterRevision: vndbStaffCreditConverterRevision }),
    },
    'facts',
  );
}

function vocabularyRequirements(plan: CrossMediaPlan, selected: ReturnType<typeof planShowcaseVndbCredits>) {
  const firstOwner = selected.requirements[0]?.sourcePath.split('/')[2];
  if (!firstOwner || !plan.records.vndb.some((record) => record.key === firstOwner)) return [];
  const scheme: ShowcaseVocabularyRequirement = {
    provider: 'vndb',
    ownerKey: firstOwner,
    sourceKey: creditTypeTaxonomy,
    source: vocabularySource(creditTypeTaxonomy, creditTypeSchemeUri),
    sourceUri: creditTypeSchemeUri,
    nativeType: 'skos:ConceptScheme',
  };
  return [
    scheme,
    ...selected.requirements.map((requirement): ShowcaseVocabularyRequirement => {
      const ownerKey = requirement.sourcePath.split('/')[2];
      if (!ownerKey || !plan.records.vndb.some((record) => record.key === ownerKey))
        throw new TypeError('VNDB credit vocabulary requirement has no selected owner');
      const sourceKey = `${requirement.taxonomy}:${requirement.code}`;
      return {
        provider: 'vndb',
        ownerKey,
        sourceKey,
        source: vocabularySource(sourceKey, requirement.conceptUri),
        sourceUri: requirement.conceptUri,
        nativeType: 'skos:Concept',
      };
    }),
  ];
}

function vocabularyReferences(uri: string): BatchReference[] {
  return [
    {
      parts: [uri, creditTypeSchemeUri].map((content) => ({
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content },
      })),
    },
  ];
}

function vocabularyCommands(
  requirement: ShowcaseVocabularyRequirement,
  schemeId?: string,
  subjectId?: string,
): VocabularyCommand[] {
  const concept = requirement.nativeType === 'skos:Concept';
  const code = concept ? requirement.sourceKey.slice(`${creditTypeTaxonomy}:`.length) : undefined;
  const label = concept ? code! : 'VNDB credit types';
  if (!subjectId)
    return [
      {
        op: 'create',
        key: `vndb-staff-credit-vocabulary:${commandKey([
          JSON.stringify(requirement.source),
          'create',
          requirement.nativeType,
          label,
        ])}`,
        source: requirement.source,
        subject: { type: requirement.nativeType, labels: concept ? { und: label } : { en: label } },
      },
    ];
  const statements: BatchStatement[] = [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: requirement.sourceUri },
      references: vocabularyReferences(requirement.sourceUri),
    },
  ];
  if (concept && schemeId) {
    statements.push({
      property: { id: 'skos:inScheme' },
      value: { type: 'value', content: schemeId },
      references: vocabularyReferences(requirement.sourceUri),
    });
  }
  return schemeId || !concept
    ? statements.map((statement) => ({
        op: 'propose' as const,
        key: `vndb-staff-credit-vocabulary:${commandKey([
          JSON.stringify(requirement.source),
          subjectId,
          'propose',
          JSON.stringify(statement),
        ])}`,
        source: requirement.source,
        subject: subjectId,
        statement,
      }))
    : [];
}

function acknowledgedCreates(journal: ShowcaseJournal, requirements: readonly ShowcaseVocabularyRequirement[]) {
  const acknowledgements = journal.acknowledgedCommands();
  const ids = new Map<string, string>();
  for (const requirement of requirements) {
    const acknowledgement = acknowledgements.find(
      (entry) =>
        entry.command.op === 'create' &&
        entry.command.subject.type === requirement.nativeType &&
        entry.command.source.external_id === requirement.source.external_id &&
        showcaseSourceMatches(entry.command.source, requirement.source),
    );
    if (!acknowledgement) continue;
    if (
      acknowledgement.commandDigest !== showcaseDigest(acknowledgement.command) ||
      !acknowledgement.subjectId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(acknowledgement.subjectId)
    )
      throw new TypeError('VNDB credit vocabulary create acknowledgement is invalid');
    ids.set(requirement.sourceKey, acknowledgement.subjectId);
  }
  return ids;
}

async function sendMissingVocabularyCommands(input: {
  port: CrossMediaPort;
  journal: ShowcaseJournal;
  requirements: readonly ShowcaseVocabularyRequirement[];
  schemeId?: string;
}): Promise<VndbCreditVocabularyDeliveryIssue[]> {
  const captured = captureShowcaseCommands(input.port, input.journal);
  const issues: VndbCreditVocabularyDeliveryIssue[] = [];
  const send = async (commands: readonly VocabularyCommand[]) => {
    const acknowledged = new Map(input.journal.acknowledgedCommands().map((entry) => [entry.command.key, entry]));
    const pending = commands.filter((command) => {
      const prior = acknowledged.get(command.key);
      if (!prior) return true;
      if (prior.commandDigest !== showcaseDigest(command) || showcaseDigest(prior.command) !== prior.commandDigest)
        throw new TypeError('VNDB credit vocabulary acknowledgement changed its sealed command');
      return false;
    });
    for (let offset = 0; offset < pending.length; offset += BATCH_LIMIT) {
      const page = pending.slice(offset, offset + BATCH_LIMIT);
      if (checkBatchWrite({ commands: page }, bundledRelease).length)
        throw new TypeError('VNDB credit vocabulary commands failed portable validation');
      const result = await captured.batch({ commands: page });
      const byKey = new Map(result.results.map((entry) => [entry.key, entry]));
      for (const command of page) {
        const response = byKey.get(command.key);
        if (!response) throw new Error('VNDB credit vocabulary delivery unknown: batch response omitted a command');
        const status = Number(response.status);
        if (status === 200 || status === 201) continue;
        if (status === 429) {
          issues.push({ sourceKey: command.source.external_id, operation: command.op, outcome: 'unavailable', status });
          continue;
        }
        if (status >= 400 && status < 500) {
          issues.push({ sourceKey: command.source.external_id, operation: command.op, outcome: 'refused', status });
          continue;
        }
        throw new Error(`VNDB credit vocabulary delivery unknown: unexpected command status ${status}`);
      }
    }
  };
  await send(input.requirements.flatMap((requirement) => vocabularyCommands(requirement)));
  const creates = acknowledgedCreates(input.journal, input.requirements);
  const proposals = input.requirements.flatMap((requirement) => {
    const subjectId = creates.get(requirement.sourceKey);
    if (!subjectId) return [];
    return vocabularyCommands(requirement, input.schemeId, subjectId).filter((command) => command.op === 'propose');
  });
  await send(proposals);
  return issues;
}

/** Stage selected credit types through the existing local journal and common publisher. */
export async function prepareShowcaseVndbCreditVocabulary(input: {
  plan: CrossMediaPlan;
  port: CrossMediaPort;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<{
  requirements: ShowcaseVocabularyRequirement[];
  issues: VndbCreditVocabularyDeliveryIssue[];
}> {
  const selected = planShowcaseVndbCredits(input.plan);
  const requirements = vocabularyRequirements(input.plan, selected);
  if (!requirements.length) return { requirements: [], issues: [] };
  const scheme = requirements[0]!;
  const schemeRequirements = [scheme];
  const schemeId = acknowledgedCreates(input.journal, schemeRequirements).get(scheme.sourceKey);
  const issues = await sendMissingVocabularyCommands({
    port: input.port,
    journal: input.journal,
    requirements: input.stage === 'schemes' ? schemeRequirements : [],
  });
  if (input.stage === 'schemes') return { requirements: schemeRequirements, issues };
  if (!schemeId) return { requirements, issues };
  const currentScheme = await readCreditTypeBindingsDetailed(input.port, { schemeId, concepts: [] });
  if (!currentScheme.bindings.schemes.length) return { requirements, issues };
  const conceptRequirements = requirements.slice(1);
  issues.push(
    ...(await sendMissingVocabularyCommands({
      port: input.port,
      journal: input.journal,
      requirements: conceptRequirements,
      schemeId,
    })),
  );
  return { requirements, issues };
}

/** Return only UUIDs that the common publisher independently reread as current and public. */
export function publishedShowcaseVndbCreditReferences(
  publication: ShowcasePublicationResult,
  journal: ShowcaseJournal,
  requirements: readonly ShowcaseVocabularyRequirement[],
): VndbCreditVocabularyReferences | undefined {
  const acknowledged = acknowledgedCreates(journal, requirements);
  const published = new Map(
    publication.published.filter((record) => record.provider === 'vndb').map((record) => [record.sourceKey, record]),
  );
  const scheme = requirements.find((requirement) => requirement.nativeType === 'skos:ConceptScheme');
  const schemeId = scheme && acknowledged.get(scheme.sourceKey);
  const publicScheme = scheme && published.get(scheme.sourceKey);
  if (
    !scheme ||
    !schemeId ||
    !publicScheme ||
    publicScheme.nativeType !== 'skos:ConceptScheme' ||
    publicScheme.subjectId !== schemeId
  )
    return undefined;
  const schemeManifest = publication.manifest.vocabulary.find((record) => record.sourceKey === scheme.sourceKey);
  if (
    !publicScheme.assertions.some((assertion) => assertion.property === 'schema:url') ||
    !schemeManifest?.assertions.some(
      (assertion) =>
        assertion.property === 'schema:url' &&
        assertion.statement.value.type === 'value' &&
        assertion.statement.value.content === scheme.sourceUri,
    )
  )
    return undefined;
  const concepts = requirements.flatMap((requirement) => {
    if (requirement.nativeType !== 'skos:Concept') return [];
    const id = acknowledged.get(requirement.sourceKey);
    const record = published.get(requirement.sourceKey);
    const manifestRecord = publication.manifest.vocabulary.find((entry) => entry.sourceKey === requirement.sourceKey);
    if (!id || !record || record.nativeType !== 'skos:Concept' || record.subjectId !== id || !manifestRecord) return [];
    if (
      !record.assertions.some((assertion) => assertion.property === 'schema:url') ||
      !record.assertions.some((assertion) => assertion.property === 'skos:inScheme') ||
      !manifestRecord.assertions.some(
        (assertion) =>
          assertion.property === 'schema:url' &&
          assertion.statement.value.type === 'value' &&
          assertion.statement.value.content === requirement.sourceUri,
      ) ||
      !manifestRecord.assertions.some(
        (assertion) =>
          assertion.property === 'skos:inScheme' &&
          assertion.statement.value.type === 'value' &&
          assertion.statement.value.content === schemeId,
      )
    )
      return [];
    return [{ code: requirement.sourceKey.slice(`${creditTypeTaxonomy}:`.length), id }];
  });
  return { schemeId, concepts };
}

export function planShowcaseVndbCredits(plan: CrossMediaPlan): {
  credits: VndbStaffCredit[];
  requirements: VndbCreditVocabularyRequirement[];
  diagnostics: SourceVocabularyGap[];
} {
  const diagnostics: SourceVocabularyGap[] = [];
  const recordRevisions = new Map(plan.records.vndb.map((record) => [record.key, record.revision]));
  const aliasNames = new Map<string, string>();
  for (const entity of plan.entities.vndb) {
    if (!/^s[1-9][0-9]*$/u.test(entity.key) || !object(entity.payload)) continue;
    const aliases = entity.payload.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (!object(alias) || alias.id !== entity.key) continue;
      const aid = sourceText(alias, 'aid');
      const name = sourceText(alias, 'name');
      if (aid && name) aliasNames.set(aid, name);
    }
  }

  const candidates: VndbStaffCredit[] = [];
  for (const edge of plan.edges) {
    if (edge.source !== 'vndb' || (edge.table !== 'vn_staff' && edge.table !== 'vn_seiyuu')) continue;
    const row = edge.record;
    const vn = sourceText(row, 'id') ?? edge.holder;
    const aliasId = sourceText(row, 'aid');
    const recordRevision = recordRevisions.get(vn);
    const path = edgePath(edge.table, row);
    if (!aliasId || !recordRevision || !path) {
      if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(gap(path ?? '/vn_staff', 'invalid_row'));
      continue;
    }
    const spelling =
      row.note === undefined || row.note === null || row.note === '' ? aliasNames.get(aliasId) : row.note;
    if (spelling !== undefined && !validSpelling(spelling)) {
      if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(gap(path, 'invalid_source_value'));
      continue;
    }
    const common = {
      vn,
      staffId: edge.target,
      aliasId,
      sourcePath: path,
      recordRevision,
      sourceDigest: sourceDigest(row),
      ...(spelling === undefined ? {} : { creditedAs: spelling }),
    };
    if (edge.table === 'vn_seiyuu') {
      const characterId = sourceText(row, 'cid');
      if (!characterId || !/^c[1-9][0-9]*$/u.test(characterId)) {
        if (diagnostics.length < DIAGNOSTIC_LIMIT)
          diagnostics.push({ ...gap(path, 'missing_identity'), property: 'wdt:P453' });
        continue;
      }
      candidates.push({ ...common, kind: 'voice', characterId });
    } else {
      const role = sourceText(row, 'role');
      if (!role) {
        if (diagnostics.length < DIAGNOSTIC_LIMIT)
          diagnostics.push({ ...gap(path, 'invalid_source_value'), property: 'vn_staff.role' });
        continue;
      }
      candidates.push({ ...common, kind: 'staff', role });
    }
  }

  candidates.sort((a, b) => a.vn.localeCompare(b.vn) || a.sourcePath.localeCompare(b.sourcePath));
  const byPath = new Map<string, VndbStaffCredit[]>();
  for (const credit of candidates) byPath.set(credit.sourcePath, [...(byPath.get(credit.sourcePath) ?? []), credit]);
  const unique: VndbStaffCredit[] = [];
  for (const [path, rows] of byPath) {
    if (new Set(rows.map((row) => row.sourceDigest)).size > 1) {
      if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(gap(path, 'invalid_row'));
      continue;
    }
    unique.push(rows[0]!);
  }

  const perVn = new Map<string, VndbStaffCredit[]>();
  for (const credit of unique) perVn.set(credit.vn, [...(perVn.get(credit.vn) ?? []), credit]);
  const credits: VndbStaffCredit[] = [];
  for (const [vn, rows] of [...perVn].sort(([a], [b]) => a.localeCompare(b))) {
    for (const credit of rows.slice(0, sourceVocabularyLimits.rows)) credits.push(credit);
    const overflow = rows[sourceVocabularyLimits.rows];
    if (overflow && diagnostics.length < DIAGNOSTIC_LIMIT)
      diagnostics.push(
        gap(overflow.sourcePath, 'command_limit', diagnosticCode(overflow.role ?? overflow.characterId)),
      );
    if (!recordRevisions.has(vn) && diagnostics.length < DIAGNOSTIC_LIMIT)
      diagnostics.push(gap('/vn_staff', 'missing_identity', vn));
  }

  return { credits, requirements: creditRequirements(credits, diagnostics), diagnostics };
}

export function validateVndbCreditVocabularyReferences(
  value: unknown,
  requirements: readonly VndbCreditVocabularyRequirement[],
): VndbCreditVocabularyReferences {
  if (!object(value) || typeof value.schemeId !== 'string' || !UUID.test(value.schemeId))
    throw new TypeError('Invalid VNDB credit vocabulary references');
  if (!Array.isArray(value.concepts) || value.concepts.length > requirements.length)
    throw new TypeError('VNDB credit vocabulary references exceed selected role codes');
  const concepts: { code: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const concept of value.concepts) {
    if (!object(concept) || typeof concept.code !== 'string' || !UUID.test(String(concept.id)))
      throw new TypeError('Invalid VNDB credit vocabulary concept reference');
    if (seen.has(concept.code)) throw new TypeError('Duplicate VNDB credit vocabulary code');
    seen.add(concept.code);
    concepts.push({ code: concept.code, id: String(concept.id) });
  }
  const expected = new Set(requirements.map((requirement) => requirement.code));
  if ([...seen].some((code) => !expected.has(code)))
    throw new TypeError('VNDB credit vocabulary references include an unselected role code');
  concepts.sort((a, b) => a.code.localeCompare(b.code));
  return { schemeId: value.schemeId, concepts };
}

export async function prepareShowcaseVndbCredits(
  plan: CrossMediaPlan,
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  references?: VndbCreditVocabularyReferences,
  readPublicSubject?: (id: string) => Promise<unknown>,
): Promise<ShowcaseVndbCredits> {
  const selected = planShowcaseVndbCredits(plan);
  const known = references ? validateVndbCreditVocabularyReferences(references, selected.requirements) : undefined;
  const current = known
    ? await readCreditTypeBindingsDetailed(port, known, readPublicSubject)
    : { bindings: emptyBindings, unavailable: [] as VndbCreditVocabularyReadFailure[] };
  const bindings = current.bindings;
  const diagnostics = [...selected.diagnostics];
  const pushDiagnostic = (entry: SourceVocabularyGap) => {
    if (diagnostics.length >= DIAGNOSTIC_LIMIT) return;
    if (!diagnostics.some((prior) => prior.path === entry.path && prior.reason === entry.reason))
      diagnostics.push(entry);
  };
  const admission = staffCreditVocabularyAdmission(bindings, selected.credits);
  const vocabularyAdmission: Admission = {
    request(context) {
      const request = admission.request?.(context);
      if (!request || !/^v[1-9][0-9]*$/u.test(context.owner.external_id)) return request;
      const conversion = context.conversion as unknown as {
        record_revision: string;
        digest: string;
        converter_revision: string;
        proposals: readonly unknown[];
      };
      let commandLimit = Math.max(0, BATCH_LIMIT - conversion.proposals.length);
      const metadata = {
        provider: 'vndb' as const,
        sourceAlias: 'vndb_cross_media',
        externalId: context.owner.external_id,
        recordRevision: conversion.record_revision,
        digest: conversion.digest,
        converterRevision: conversion.converter_revision,
        recordUrl: vndbRecordUrl(context.owner.external_id),
        license: 'ODbL-1.0',
        attribution: 'VNDB',
      };
      for (const row of request.rows) {
        const preview = mapVndbVocabulary({ metadata, bindings: request.bindings, rows: [row], commandLimit });
        commandLimit = Math.max(0, commandLimit - preview.proposals.length);
        for (const entry of preview.gaps) pushDiagnostic(entry);
      }
      return request;
    },
  };
  return {
    ...selected,
    diagnostics,
    vocabularyUnavailable: current.unavailable,
    vocabularyAdmission,
    deliveryEdges(edges) {
      return edges.filter(
        (edge) => edge.source !== 'vndb' || (edge.table !== 'vn_staff' && edge.table !== 'vn_seiyuu'),
      );
    },
  };
}

export function combineVocabularyRequests(
  requests: readonly (SourceVocabularyRequest | undefined)[],
): SourceVocabularyRequest | undefined {
  const admitted = requests.filter((request): request is SourceVocabularyRequest => request !== undefined);
  if (!admitted.length) return undefined;
  const bindings: SourceVocabularyBindings = {
    releaseDigest: bundledDigest,
    schemes: admitted.flatMap((request) => request.bindings.schemes),
    concepts: admitted.flatMap((request) => request.bindings.concepts),
  };
  const schemes = new Map(bindings.schemes.map((scheme) => [`${scheme.taxonomy}\u0000${scheme.id}`, scheme]));
  const concepts = new Map(bindings.concepts.map((concept) => [`${concept.taxonomy}\u0000${concept.code}`, concept]));
  return {
    bindings: { releaseDigest: bundledDigest, schemes: [...schemes.values()], concepts: [...concepts.values()] },
    rows: admitted.flatMap((request) => request.rows),
  };
}
