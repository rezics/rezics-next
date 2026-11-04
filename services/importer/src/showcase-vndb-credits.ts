import { bundledDigest } from '@rezics/definitions/bundled';
import { BATCH_LIMIT } from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings, SourceVocabularyGap, SourceVocabularyRequest } from '@rezics/conversion';
import { sourceVocabularyLimits } from '@rezics/conversion/source-vocabulary';
import { vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import { mapVndbVocabulary } from '@rezics/conversion/vndb-vocabulary';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import type { ImporterOptions } from './importer.ts';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  creditTypeTaxonomy,
  readCreditTypeBindings,
  staffCreditVocabularyAdmission,
  type VndbStaffCredit,
} from './vndb-staff-credits.ts';

type Row = Record<string, unknown>;
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

export type ShowcaseVndbCredits = {
  credits: VndbStaffCredit[];
  requirements: VndbCreditVocabularyRequirement[];
  diagnostics: SourceVocabularyGap[];
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

function creditRequirements(credits: readonly VndbStaffCredit[]): VndbCreditVocabularyRequirement[] {
  const firstPath = new Map<string, string>();
  for (const credit of credits) {
    if (credit.kind === 'staff' && credit.role && CREDIT_CODE.test(credit.role) && !firstPath.has(credit.role))
      firstPath.set(credit.role, credit.sourcePath);
  }
  return [...firstPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, sourceVocabularyLimits.concepts)
    .map(([code, sourcePath]) => ({
      taxonomy: creditTypeTaxonomy,
      code,
      schemeUri: creditTypeSchemeUri,
      conceptUri: creditTypeConceptUri(code),
      sourcePath,
    }));
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

  return { credits, requirements: creditRequirements(credits), diagnostics };
}

export function validateVndbCreditVocabularyReferences(
  value: unknown,
  requirements: readonly VndbCreditVocabularyRequirement[],
): VndbCreditVocabularyReferences {
  if (!object(value) || typeof value.schemeId !== 'string' || !UUID.test(value.schemeId))
    throw new TypeError('Invalid VNDB credit vocabulary references');
  if (!Array.isArray(value.concepts) || value.concepts.length !== requirements.length)
    throw new TypeError('VNDB credit vocabulary references do not match selected role codes');
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
  if (seen.size !== expected.size || [...seen].some((code) => !expected.has(code)))
    throw new TypeError('VNDB credit vocabulary references do not match selected role codes');
  concepts.sort((a, b) => a.code.localeCompare(b.code));
  return { schemeId: value.schemeId, concepts };
}

export async function prepareShowcaseVndbCredits(
  plan: CrossMediaPlan,
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  references?: VndbCreditVocabularyReferences,
): Promise<ShowcaseVndbCredits> {
  const selected = planShowcaseVndbCredits(plan);
  const known = references ? validateVndbCreditVocabularyReferences(references, selected.requirements) : undefined;
  const bindings = known ? await readCreditTypeBindings(port, known) : emptyBindings;
  const diagnostics = [...selected.diagnostics];
  const pushDiagnostic = (entry: SourceVocabularyGap) => {
    if (diagnostics.length >= DIAGNOSTIC_LIMIT) return;
    if (!diagnostics.some((prior) => prior.path === entry.path && prior.reason === entry.reason))
      diagnostics.push(entry);
  };
  const creditedPaths = new Set<string>();
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
        if (preview.proposals.length) creditedPaths.add(row.path);
      }
      return request;
    },
  };
  return {
    ...selected,
    diagnostics,
    vocabularyAdmission,
    deliveryEdges(edges) {
      return edges.filter((edge) => {
        if (edge.source !== 'vndb') return true;
        if (edge.table === 'vn_seiyuu') return false;
        if (edge.table === 'vn_staff') {
          const path = edgePath('vn_staff', edge.record);
          return !path || !creditedPaths.has(path);
        }
        return true;
      });
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
