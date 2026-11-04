import { BATCH_LIMIT, checkBatchWrite, type BatchCommand, type BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import type { ReviewedSubjectRead } from './import-client.ts';
import { mapBangumiVocabulary } from '@rezics/conversion/bangumi-vocabulary';
import { bangumiRecordUrl, converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import {
  sourceVocabularyLimits,
  type BangumiVocabularyRow,
  type NativeIdentity,
  type SourceVocabularyBindings,
  type SourceVocabularyGap,
  type SourceVocabularyMetadata,
} from '@rezics/conversion/source-vocabulary';
import type { Claim } from './record-bindings.ts';
import { createImporter } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createSourceRegistration } from './source-registry.ts';

export type BangumiCreatorCreditPort = Pick<
  ReturnType<typeof createImportTransport>,
  | 'batch'
  | 'setSourceRecordMetadata'
  | 'fence'
  | 'writeSourceStatistic'
  | 'clearSourceStatistic'
  | 'readReviewedSubject'
>;

/** Pinned Bangumi inventory omission for music (3) and live-action (6) staff codes. */
export const musicLiveActionStaffReason =
  'Music and live-action staff, relation and unprofiled format codes await row-6 vocabulary binding.';

export type BangumiStaffAssociation = {
  subject_id: number;
  person_id: number;
  position: number;
  creditedAs?: string;
};

export type BangumiVoiceAssociation = {
  subject_id: number;
  person_id: number;
  character_id: number;
  creditedAs?: string;
};

export type BangumiCreatorCreditDraft = {
  kind: 'staff' | 'voice-credit';
  work: string;
  workType: number;
  person: string;
  character?: string;
  roleCode?: number;
  creditedAs?: string;
  path: string;
  record: Record<string, unknown>;
};

export type BangumiCreatorCreditGap =
  | SourceVocabularyGap
  | {
      provider: 'bangumi';
      path: string;
      code?: string;
      reason: typeof musicLiveActionStaffReason;
      property: 'staff.3' | 'staff.6';
    };

export type BangumiCreatorCreditResult = {
  proposals: BatchCommand[];
  gaps: BangumiCreatorCreditGap[];
  fenced: string[];
  keys: string[];
  identities: Record<string, NativeIdentity>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const aliasDefault = 'bangumi_cross_media';

function personKey(id: number): string {
  return `person:${id}`;
}
function characterKey(id: number): string {
  return `character:${id}`;
}

export function bangumiStaffDraft(row: BangumiStaffAssociation, workType: number): BangumiCreatorCreditDraft {
  const work = String(row.subject_id);
  const person = personKey(row.person_id);
  return {
    kind: 'staff',
    work,
    workType,
    person,
    roleCode: row.position,
    ...(row.creditedAs !== undefined ? { creditedAs: row.creditedAs } : {}),
    path: `/subject-persons/${work}/${row.person_id}/position`,
    record: { ...row },
  };
}

export function bangumiVoiceDraft(row: BangumiVoiceAssociation, workType: number): BangumiCreatorCreditDraft {
  const work = String(row.subject_id);
  const person = personKey(row.person_id);
  const character = characterKey(row.character_id);
  return {
    kind: 'voice-credit',
    work,
    workType,
    person,
    character,
    ...(row.creditedAs !== undefined ? { creditedAs: row.creditedAs } : {}),
    path: `/person-characters/${work}/${row.person_id}/${row.character_id}`,
    record: { ...row },
  };
}

function nativeType(read: { subject?: { type?: string } } | null | undefined): string | undefined {
  const type = read?.subject?.type;
  return typeof type === 'string' && type.length > 0 ? type : undefined;
}

export function buildBangumiCreatorCreditRows(input: {
  drafts: readonly BangumiCreatorCreditDraft[];
  identities: Readonly<Record<string, NativeIdentity | undefined>>;
}): { rows: BangumiVocabularyRow[]; gaps: BangumiCreatorCreditGap[] } {
  const rows: BangumiVocabularyRow[] = [];
  const gaps: BangumiCreatorCreditGap[] = [];
  for (const draft of input.drafts) {
    if (draft.kind === 'staff' && (draft.workType === 3 || draft.workType === 6)) {
      gaps.push({
        provider: 'bangumi',
        path: draft.path,
        ...(typeof draft.roleCode === 'number' ? { code: String(draft.roleCode) } : {}),
        reason: musicLiveActionStaffReason,
        property: draft.workType === 3 ? 'staff.3' : 'staff.6',
      });
      continue;
    }
    const subject = input.identities[draft.work];
    if (!subject) {
      gaps.push({
        provider: 'bangumi',
        path: draft.path,
        reason: 'missing_identity',
        property: draft.kind === 'staff' ? `staff.${draft.workType}` : 'wdt:P725',
      });
      continue;
    }
    if (draft.kind === 'staff') {
      if (draft.workType !== 1 && draft.workType !== 2 && draft.workType !== 4) {
        gaps.push({
          provider: 'bangumi',
          path: draft.path,
          ...(typeof draft.roleCode === 'number' ? { code: String(draft.roleCode) } : {}),
          reason: 'unsupported_source_case',
          property: `staff.${draft.workType}`,
        });
        continue;
      }
      const holder = input.identities[draft.person];
      rows.push({
        kind: 'staff',
        path: draft.path,
        subject,
        ...(holder ? { holder } : {}),
        holderCode: draft.person,
        subjectType: draft.workType,
        roleCode: draft.roleCode ?? 0,
        ...(draft.creditedAs !== undefined ? { creditedAs: draft.creditedAs } : {}),
      });
      continue;
    }
    if (draft.workType !== 2 && draft.workType !== 4) {
      gaps.push({
        provider: 'bangumi',
        path: draft.path,
        reason: 'unsupported_source_case',
        property: 'wdt:P725',
      });
      continue;
    }
    const performer = input.identities[draft.person];
    const character = draft.character ? input.identities[draft.character] : undefined;
    rows.push({
      kind: 'voice-credit',
      path: draft.path,
      subject,
      ...(performer ? { performer } : {}),
      performerCode: draft.person,
      ...(character ? { character } : {}),
      characterCode: draft.character ?? '',
      ...(draft.creditedAs !== undefined ? { creditedAs: draft.creditedAs } : {}),
    });
  }
  return { rows, gaps };
}

export async function deliverBangumiCreatorCredits(input: {
  alias?: string;
  converterRevision?: string;
  drafts: readonly BangumiCreatorCreditDraft[];
  bindings: SourceVocabularyBindings;
  claim(owner: { source: string; external_id: string }): Claim | null;
  batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult>;
  fence?(tuple: { source: string; externalId: string; fieldGroup: 'facts' }): Promise<{ fenced: boolean }>;
  read(subjectId: string): Promise<ReviewedSubjectRead>;
  expectedNativeType(externalId: string): string | undefined;
  metadataFor(work: string): Pick<SourceVocabularyMetadata, 'digest' | 'recordRevision' | 'recordUrl'>;
}): Promise<BangumiCreatorCreditResult> {
  const alias = input.alias ?? aliasDefault;
  const converterRevision = input.converterRevision ?? entityRevision;
  const fenced: string[] = [];
  const proposals: BatchCommand[] = [];
  const gaps: BangumiCreatorCreditGap[] = [];
  const keys: string[] = [];
  const identities: Record<string, NativeIdentity> = {};
  const reads = new Map<string, Promise<ReviewedSubjectRead | null>>();
  const readCurrent = (id: string): Promise<ReviewedSubjectRead | null> => {
    let pending = reads.get(id);
    if (!pending) {
      pending = input.read(id).catch(() => null);
      reads.set(id, pending);
    }
    return pending;
  };
  const works = [...new Set(input.drafts.map((draft) => draft.work))];
  for (const work of works) {
    const owned = input.drafts.filter((draft) => draft.work === work);
    if (input.fence) {
      const state = await input.fence({ source: alias, externalId: work, fieldGroup: 'facts' });
      if (state.fenced) {
        fenced.push(work);
        continue;
      }
    }
    const resolved: Record<string, NativeIdentity | undefined> = {};
    const endpoints = new Set<string>();
    for (const draft of owned) {
      endpoints.add(draft.work);
      endpoints.add(draft.person);
      if (draft.character) endpoints.add(draft.character);
    }
    for (const key of endpoints) {
      const claim = input.claim({ source: alias, external_id: key });
      if (claim?.state !== 'bound' || !uuid.test(claim.subject)) continue;
      const current = await readCurrent(claim.subject);
      const subject = current?.subject as
        | {
            id?: unknown;
            type?: unknown;
            statements?: Record<string, readonly { value?: { type?: unknown; content?: unknown } }[]>;
          }
        | undefined;
      const type = nativeType(current);
      const expectedType = input.expectedNativeType(key);
      const identityProperty = key.startsWith('person:')
        ? 'wdt:P6298'
        : key.startsWith('character:')
          ? 'wdt:P6296'
          : /^\d+$/u.test(key)
            ? 'wdt:P5732'
            : undefined;
      const sourceId =
        key.startsWith('person:') || key.startsWith('character:') ? key.slice(key.indexOf(':') + 1) : key;
      const hasIdentity =
        identityProperty !== undefined &&
        (subject?.statements?.[identityProperty]?.some(
          (statement) => statement.value?.type === 'value' && statement.value.content === sourceId,
        ) ??
          false);
      if (!type || subject?.id !== claim.subject || type !== expectedType || !hasIdentity) continue;
      const identity = { id: claim.subject, type, releaseDigest: bundledDigest };
      resolved[key] = identity;
      identities[key] = identity;
    }
    const built = buildBangumiCreatorCreditRows({ drafts: owned, identities: resolved });
    gaps.push(...built.gaps);
    if (built.rows.length === 0) continue;
    const meta = input.metadataFor(work);
    const metadata = {
      provider: 'bangumi' as const,
      sourceAlias: alias,
      externalId: work,
      recordRevision: meta.recordRevision,
      digest: meta.digest,
      converterRevision,
      recordUrl: meta.recordUrl,
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    };
    for (let offset = 0; offset < built.rows.length; offset += sourceVocabularyLimits.rows) {
      const mapped = mapBangumiVocabulary({
        metadata,
        bindings: input.bindings,
        rows: built.rows.slice(offset, offset + sourceVocabularyLimits.rows),
      });
      gaps.push(...mapped.gaps);
      proposals.push(...mapped.proposals);
    }
  }
  for (let offset = 0; offset < proposals.length; offset += BATCH_LIMIT) {
    const page = proposals.slice(offset, offset + BATCH_LIMIT);
    if (checkBatchWrite({ commands: page }).length)
      throw new TypeError('Bangumi creator credit proposals failed portable validation');
    const result = await input.batch({ commands: page });
    for (const [index, command] of page.entries()) {
      const status = result.results[index]?.status;
      if (status !== 200 && status !== 201) throw new TypeError(`Bangumi creator credit write failed: ${status}`);
      keys.push(command.key);
    }
  }
  return { proposals, gaps, fenced, keys, identities };
}

export async function importBangumiCreatorCredits(input: {
  path: string;
  port: BangumiCreatorCreditPort;
  destination?: { origin: string };
  work: SourceRecord;
  people: readonly SourceRecord[];
  characters?: readonly SourceRecord[];
  staff?: readonly BangumiStaffAssociation[];
  voice?: readonly BangumiVoiceAssociation[];
  bindings: SourceVocabularyBindings;
  alias?: string;
  converterRevision?: string;
}): Promise<BangumiCreatorCreditResult> {
  const alias = input.alias ?? aliasDefault;
  const converterRevision = input.converterRevision ?? entityRevision;
  const workType =
    input.work.payload && typeof input.work.payload === 'object' && 'type' in input.work.payload
      ? Number((input.work.payload as { type?: unknown }).type)
      : 0;
  const drafts = [
    ...(input.staff ?? []).map((row) => bangumiStaffDraft(row, workType)),
    ...(input.voice ?? []).map((row) => bangumiVoiceDraft(row, workType)),
  ];
  const registration = createSourceRegistration('bangumi', { source: alias, converterRevision });
  const importer = createImporter({
    path: input.path,
    ...(input.destination ? { destination: input.destination } : {}),
    transport: {
      batchWrite: (request) => input.port.batch(request),
      setSourceRecordMetadata: (request, signal) => input.port.setSourceRecordMetadata(request, signal),
      readFence: (tuple) =>
        input.port.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
      writeSourceStatistic: (request, signal) => input.port.writeSourceStatistic(request, signal),
      clearSourceStatistic: (request, signal) => input.port.clearSourceStatistic(request, signal),
    },
  });
  try {
    async function* records() {
      yield input.work;
      yield* input.people;
      yield* input.characters ?? [];
    }
    const run = await importer.runRecords(registration, records());
    if (run.status !== 'committed') throw new TypeError(`Bangumi creator credit import failed: ${run.status}`);
    const conversion = registration.convert(
      { external_id: input.work.key, record_revision: input.work.revision, record: input.work.payload },
      { source: alias },
    );
    return await deliverBangumiCreatorCredits({
      alias,
      converterRevision,
      drafts,
      bindings: input.bindings,
      claim: (owner) => importer.session.bindings.claim(owner),
      batch: (request) => input.port.batch(request),
      fence: (tuple) => input.port.fence(tuple),
      read: (subjectId) => input.port.readReviewedSubject(subjectId),
      expectedNativeType: (externalId) => {
        if (externalId === input.work.key) {
          const bootstrap = registration
            .convert(
              { external_id: input.work.key, record_revision: input.work.revision, record: input.work.payload },
              { source: alias },
            )
            .proposals.find((command) => command.op === 'create');
          return bootstrap?.op === 'create' ? bootstrap.subject.type : undefined;
        }
        const row = [...input.people, ...(input.characters ?? [])].find((record) => record.key === externalId);
        if (!row) return undefined;
        const bootstrap = registration
          .convert({ external_id: row.key, record_revision: row.revision, record: row.payload }, { source: alias })
          .proposals.find((command) => command.op === 'create');
        return bootstrap?.op === 'create' ? bootstrap.subject.type : undefined;
      },
      metadataFor: () => ({
        digest: conversion.digest,
        recordRevision: input.work.revision,
        recordUrl: bangumiRecordUrl(input.work.key),
      }),
    });
  } finally {
    await importer.close();
  }
}
