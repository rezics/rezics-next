import { createHash } from 'node:crypto';
import type {
  PersonalEntryFieldChange,
  PersonalEntry,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampInput,
} from './entry-personal-model.ts';
import {
  MAX_PERSONAL_NOTE_BYTES,
  MAX_SOURCE_OBSERVATIONS,
  MAX_SOURCE_PRIVACY_VALUE_BYTES,
  MAX_SOURCE_TIMESTAMP_LENGTH,
} from './entry-personal-model.ts';
import type { Actor } from '../request/access.ts';
import type { CommandOutcome } from '../command/command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { LibraryConflictError } from './entry-errors.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import { ProblemError } from '../http/problem.ts';

export const ENTRY_IMPORT_METADATA_LIMITS = {
  fields: 5,
  reviewsPerRow: 2,
  requestBytes: 2048,
  reviewBytes: 32768,
  rowBytes: 65536,
  noteBytes: MAX_PERSONAL_NOTE_BYTES,
  privacyValueBytes: MAX_SOURCE_PRIVACY_VALUE_BYTES,
  timestampBytes: MAX_SOURCE_TIMESTAMP_LENGTH,
  responseBytes: 65536,
} as const;

export type EntryImportMetadataField = 'note' | 'priority' | 'privacy' | 'sourceCreated' | 'sourceUpdated';
export type EntryImportMetadataProposal = Readonly<{
  state: 'value' | 'absent' | 'unknown' | 'empty' | 'invalid' | 'unsupported';
  sourceField: string | null;
  value?: string | number | PersonalEntryPrivacyValue | PersonalEntryTimestampInput;
  sourceValue?: string | number | boolean | null;
  mapping?: Readonly<{ id: string; label: string }>;
  reason?: string;
}>;
export type EntryImportMetadataProposals = Readonly<Record<EntryImportMetadataField, EntryImportMetadataProposal>>;
export type EntryImportMetadataSelection = Readonly<{
  field: EntryImportMetadataField;
  action: 'adopt' | 'clear';
  mapping?: string;
}>;
export type EntryImportMetadataFieldOutcome = Readonly<{
  field: EntryImportMetadataField;
  status: 'applied' | 'stale' | 'unsupported' | 'unattempted' | 'failed';
  reason?: string;
}>;
export type EntryImportMetadataOutcome = Readonly<{
  reviewToken: string;
  fields: readonly EntryImportMetadataFieldOutcome[];
}>;
export type EntryImportMetadataConfirmation = {
  fields: EntryImportMetadataSelection[];
  selectionDigest: string;
  annotationKey: string;
  provenanceKey: string;
  annotationStarted: boolean;
  provenanceStarted: boolean;
  outcome?: EntryImportMetadataOutcome;
  annotationStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
  provenanceStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
  annotationInput?: {
    revision: number;
    note: PersonalEntryFieldChange<string>;
    priority: PersonalEntryFieldChange<number>;
    effect: boolean;
    expectedRevision: number;
    expectedNote: string | null;
    expectedPriority: number | null;
  };
  provenanceInput?:
    | { kind: 'admit'; value: PersonalEntrySourceAdmission; effect: true }
    | { kind: 'correct'; value: PersonalEntrySourceCorrection; effect: boolean };
  sourceObservationDigest?: string;
};
export type EntryImportMetadataReview = {
  token: string;
  requestDigest: string;
  sourceReviewToken: string;
  subjectId: string;
  clientId: string;
  requestedBy: string | null;
  annotationRevision: number;
  personalDigest: string;
  sourceDigest: string;
  profileDigest: string;
  incarnationId: string | null;
  confirmation?: EntryImportMetadataConfirmation;
};
export type EntryImportMetadataView = Readonly<{
  status: 'current' | 'stale';
  reviewToken: string;
  sourceReviewToken: string;
  subjectId: string;
  personal: PersonalEntry;
  proposals: EntryImportMetadataProposals;
  outcome: EntryImportMetadataOutcome | null;
}>;

const fields = new Set<EntryImportMetadataField>(['note', 'priority', 'privacy', 'sourceCreated', 'sourceUpdated']);

export function parseEntryImportMetadataSelections(value: unknown): EntryImportMetadataSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ENTRY_IMPORT_METADATA_LIMITS.fields)
    throw new ProblemError('invalid_request');
  const result: EntryImportMetadataSelection[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProblemError('invalid_request');
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !['field', 'action', 'mapping'].includes(key)) ||
      typeof row.field !== 'string' ||
      !fields.has(row.field as EntryImportMetadataField) ||
      (row.action !== 'adopt' && row.action !== 'clear') ||
      (row.mapping !== undefined && (row.field !== 'priority' || typeof row.mapping !== 'string'))
    )
      throw new ProblemError('invalid_request');
    result.push({
      field: row.field as EntryImportMetadataField,
      action: row.action,
      ...(row.mapping === undefined ? {} : { mapping: row.mapping }),
    });
  }
  if (new Set(result.map((item) => item.field)).size !== result.length) throw new ProblemError('invalid_request');
  if (Buffer.byteLength(JSON.stringify(result)) > ENTRY_IMPORT_METADATA_LIMITS.requestBytes)
    throw new ProblemError('invalid_request');
  return result;
}

export function entryImportMetadataDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

export function entryPersonalMetadataDigest(personal: PersonalEntry): string {
  return entryImportMetadataDigest({
    subjectId: personal.subjectId,
    annotationRevision: personal.annotationRevision,
    note: personal.note,
    priority: personal.priority,
    sourceObservations: [...personal.sourceObservations]
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.recordId.localeCompare(b.recordId))
      .map((observation) => ({
        provider: observation.provider,
        recordId: observation.recordId,
        revision: observation.revision,
        privacy: observation.privacy,
        sourceCreated: observation.sourceCreated,
        sourceUpdated: observation.sourceUpdated,
        recordedAt: observation.recordedAt,
      })),
  });
}

export function metadataObservation(personal: PersonalEntry, provider: string, recordId: string) {
  return personal.sourceObservations.find((item) => item.provider === provider && item.recordId === recordId) ?? null;
}

export function metadataValueState(value: EntryImportMetadataProposal): string {
  return value.state === 'value' || value.state === 'absent' || value.state === 'unknown' ? value.state : 'unsupported';
}

export function assertEntryImportMetadataHistorySize(history: readonly EntryImportMetadataReview[]): void {
  if (
    history.length > ENTRY_IMPORT_METADATA_LIMITS.reviewsPerRow ||
    history.some((item) => Buffer.byteLength(JSON.stringify(item)) > ENTRY_IMPORT_METADATA_LIMITS.reviewBytes) ||
    Buffer.byteLength(JSON.stringify(history)) > ENTRY_IMPORT_METADATA_LIMITS.rowBytes
  )
    throw new ProblemError('invalid_request');
}

export async function applyEntryImportMetadataCommands(input: {
  actor: Actor;
  subjectId: string;
  provider: string;
  recordId: string;
  reviewToken: string;
  personal: PersonalEntry;
  proposals: EntryImportMetadataProposals;
  selections: readonly EntryImportMetadataSelection[];
  baselineAnnotationRevision: number;
  confirmation: EntryImportMetadataConfirmation;
  native: ReturnType<typeof createEntryPersonalCommands>;
  persist: (confirmation: EntryImportMetadataConfirmation) => Promise<void>;
  record?: (outcome: CommandOutcome<unknown>) => void;
  isCancelled: () => Promise<boolean>;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{ outcome: EntryImportMetadataOutcome; complete: boolean }> {
  const { actor, subjectId, provider, recordId, reviewToken, personal, proposals, selections, native, persist } = input;
  const confirmation = input.confirmation;
  let permanentlyUnattempted = false;
  if (confirmation.outcome) return { outcome: confirmation.outcome, complete: true };
  if (confirmation.annotationStatus === 'unattempted') confirmation.annotationStatus = undefined;
  if (confirmation.provenanceStatus === 'unattempted') confirmation.provenanceStatus = undefined;

  if (!confirmation.annotationStarted && !confirmation.provenanceStarted) {
    const current = await native.readPersonalEntry(actor, subjectId);
    if (
      current.annotationRevision !== input.baselineAnnotationRevision ||
      current.note !== personal.note ||
      current.priority !== personal.priority ||
      entryImportMetadataDigest(current.sourceObservations) !== entryImportMetadataDigest(personal.sourceObservations)
    ) {
      const outcome: EntryImportMetadataOutcome = {
        reviewToken,
        fields: selections.map(({ field }) => ({ field, status: 'stale' })),
      };
      confirmation.outcome = outcome;
      await persist(confirmation);
      return { outcome, complete: true };
    }
  }

  const result = new Map<EntryImportMetadataField, EntryImportMetadataFieldOutcome>();
  const observation = metadataObservation(personal, provider, recordId);
  const annotation = selections.filter((selection) => selection.field === 'note' || selection.field === 'priority');
  const provenance = selections.filter(
    (selection) =>
      selection.field === 'privacy' || selection.field === 'sourceCreated' || selection.field === 'sourceUpdated',
  );

  const supported = (selection: EntryImportMetadataSelection) => {
    if (selection.action === 'clear') return true;
    const proposal = proposals[selection.field];
    if (proposal.state !== 'value' && proposal.state !== 'absent' && proposal.state !== 'unknown') return false;
    if (selection.field === 'note')
      return (
        typeof proposal.value === 'string' &&
        Buffer.byteLength(proposal.value) <= ENTRY_IMPORT_METADATA_LIMITS.noteBytes
      );
    if (selection.field === 'priority') {
      if (
        typeof proposal.value !== 'number' ||
        !Number.isInteger(proposal.value) ||
        proposal.value < 1 ||
        proposal.value > 100
      )
        return false;
      return !proposal.mapping || selection.mapping === proposal.mapping.id;
    }
    return typeof proposal.value === 'object' && proposal.value !== null;
  };

  for (const selection of selections) {
    if (
      selection.action === 'adopt' &&
      selection.field === 'priority' &&
      proposals.priority.mapping &&
      selection.mapping !== proposals.priority.mapping.id
    )
      result.set(selection.field, {
        field: selection.field,
        status: 'unsupported',
        reason: `Confirm the displayed ${proposals.priority.mapping.id} mapping to adopt this priority.`,
      });
    else if (selection.action === 'adopt' && !supported(selection))
      result.set(selection.field, {
        field: selection.field,
        status: 'unsupported',
        reason: proposals[selection.field].reason ?? 'The retained value has no installed native mapping.',
      });
  }

  const eligibleAnnotation = annotation.filter((selection) => !result.has(selection.field));
  if (eligibleAnnotation.length) {
    if (!confirmation.annotationInput) {
      const noteSelection = eligibleAnnotation.find((selection) => selection.field === 'note');
      const prioritySelection = eligibleAnnotation.find((selection) => selection.field === 'priority');
      const note = !noteSelection
        ? { op: 'unchanged' as const }
        : noteSelection.action === 'clear'
          ? personal.note === null
            ? { op: 'unchanged' as const }
            : { op: 'clear' as const }
          : personal.note === proposals.note.value
            ? { op: 'unchanged' as const }
            : { op: 'set' as const, value: proposals.note.value as string };
      const priority = !prioritySelection
        ? { op: 'unchanged' as const }
        : prioritySelection.action === 'clear'
          ? personal.priority === null
            ? { op: 'unchanged' as const }
            : { op: 'clear' as const }
          : personal.priority === proposals.priority.value
            ? { op: 'unchanged' as const }
            : { op: 'set' as const, value: proposals.priority.value as number };
      const expectedNote = note.op === 'set' ? note.value : note.op === 'clear' ? null : personal.note;
      const expectedPriority =
        priority.op === 'set' ? priority.value : priority.op === 'clear' ? null : personal.priority;
      confirmation.annotationInput = {
        revision: input.baselineAnnotationRevision,
        note,
        priority,
        effect: note.op !== 'unchanged' || priority.op !== 'unchanged',
        expectedRevision:
          input.baselineAnnotationRevision + (note.op !== 'unchanged' || priority.op !== 'unchanged' ? 1 : 0),
        expectedNote,
        expectedPriority,
      };
      await persist(confirmation);
    }
    const annotationInput = confirmation.annotationInput;
    if (confirmation.annotationStatus && confirmation.annotationStatus !== 'unattempted') {
      for (const selection of eligibleAnnotation)
        result.set(selection.field, { field: selection.field, status: confirmation.annotationStatus });
    } else if (!annotationInput.effect) {
      confirmation.annotationStatus = 'applied';
      await persist(confirmation);
      for (const selection of eligibleAnnotation)
        result.set(selection.field, { field: selection.field, status: 'applied' });
    } else {
      let shouldRun = true;
      if (!confirmation.annotationStarted) {
        if (input.signal?.aborted) {
          shouldRun = false;
          confirmation.annotationStatus = 'unattempted';
        } else if (await input.isCancelled()) {
          shouldRun = false;
          permanentlyUnattempted = true;
          confirmation.annotationStatus = 'unattempted';
        } else if (input.isCurrent && !(await input.isCurrent())) {
          shouldRun = false;
          confirmation.annotationStatus = 'stale';
        } else {
          confirmation.annotationStarted = true;
          await persist(confirmation);
        }
      }
      if (!shouldRun) {
        await persist(confirmation);
        for (const selection of eligibleAnnotation)
          result.set(selection.field, { field: selection.field, status: confirmation.annotationStatus! });
      } else {
        try {
          const command = await native.saveAnnotations(
            actor,
            subjectId,
            { revision: annotationInput.revision, note: annotationInput.note, priority: annotationInput.priority },
            confirmation.annotationKey,
          );
          input.record?.(command as CommandOutcome<unknown>);
          confirmation.annotationStatus = 'applied';
          await persist(confirmation);
          for (const selection of eligibleAnnotation)
            result.set(selection.field, { field: selection.field, status: 'applied' });
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          const status = staleEffect(error) ? 'stale' : 'failed';
          if (status === 'stale') {
            confirmation.annotationStatus = status;
            await persist(confirmation);
          }
          for (const selection of eligibleAnnotation) result.set(selection.field, { field: selection.field, status });
        }
      }
    }
  }

  const eligibleProvenance = provenance.filter((selection) => !result.has(selection.field));
  if (eligibleProvenance.length) {
    if (confirmation.provenanceStatus && confirmation.provenanceStatus !== 'unattempted') {
      for (const selection of eligibleProvenance)
        result.set(selection.field, { field: selection.field, status: confirmation.provenanceStatus });
    } else {
      const validSelections = eligibleProvenance.filter(
        (selection) => supported(selection) && (observation || selection.action !== 'clear'),
      );
      for (const selection of eligibleProvenance.filter((item) => !validSelections.includes(item)))
        result.set(selection.field, {
          field: selection.field,
          status: 'unsupported',
          reason: observation
            ? proposals[selection.field].reason
            : 'A source observation must exist before a native clear.',
        });
      let create = false;
      if (!observation && validSelections.length) {
        create =
          validSelections.length === 3 &&
          validSelections.every((selection) => selection.action === 'adopt') &&
          ['privacy', 'sourceCreated', 'sourceUpdated'].every((field) =>
            validSelections.some((selection) => selection.field === field),
          );
        if (!create) {
          for (const selection of validSelections)
            result.set(selection.field, {
              field: selection.field,
              status: 'unsupported',
              reason: 'Select every supported provenance field to use the native atomic admission command.',
            });
        } else if (personal.sourceObservations.length >= MAX_SOURCE_OBSERVATIONS) {
          for (const selection of validSelections)
            result.set(selection.field, {
              field: selection.field,
              status: 'unsupported',
              reason: 'The native source-observation limit is reached.',
            });
          create = false;
        }
      }
      const actionable = eligibleProvenance.filter((selection) => !result.has(selection.field));
      if (actionable.length && !confirmation.provenanceInput) {
        const change = (selection: EntryImportMetadataSelection | undefined) => {
          if (!selection) return { op: 'unchanged' as const };
          if (selection.action === 'clear') return { op: 'clear' as const };
          return { op: 'set' as const, value: proposals[selection.field].value };
        };
        if (create) {
          confirmation.provenanceInput = {
            kind: 'admit',
            effect: true,
            value: {
              provider,
              recordId,
              confirmReviewed: true,
              privacy: proposals.privacy.value as PersonalEntryPrivacyValue,
              sourceCreated: proposals.sourceCreated.value as PersonalEntryTimestampInput,
              sourceUpdated: proposals.sourceUpdated.value as PersonalEntryTimestampInput,
            },
          };
        } else {
          const selected = (field: EntryImportMetadataField) => actionable.find((item) => item.field === field);
          const same = (selection: EntryImportMetadataSelection | undefined) => {
            if (!selection || !observation) return false;
            const current = observation[selection.field as 'privacy' | 'sourceCreated' | 'sourceUpdated'];
            return selection.action === 'clear'
              ? current.status === 'cleared'
              : JSON.stringify(current) === JSON.stringify(proposals[selection.field].value);
          };
          const effective = actionable.filter((selection) => !same(selection));
          const exactChange = (field: EntryImportMetadataField) =>
            same(selected(field)) ? { op: 'unchanged' as const } : change(selected(field));
          confirmation.provenanceInput = {
            kind: 'correct',
            effect: effective.length > 0,
            value: {
              provider,
              recordId,
              revision: observation!.revision,
              confirmReviewed: true,
              privacy: exactChange('privacy') as PersonalEntrySourceCorrection['privacy'],
              sourceCreated: exactChange('sourceCreated') as PersonalEntrySourceCorrection['sourceCreated'],
              sourceUpdated: exactChange('sourceUpdated') as PersonalEntrySourceCorrection['sourceUpdated'],
            },
          };
        }
        confirmation.sourceObservationDigest = entryImportMetadataDigest(personal.sourceObservations);
        await persist(confirmation);
      }
      const provenanceInput = confirmation.provenanceInput;
      if (actionable.length && provenanceInput) {
        const runProvenance = async () => {
          try {
            const command =
              provenanceInput.kind === 'admit'
                ? await native.admitSourceObservation(
                    actor,
                    subjectId,
                    provenanceInput.value,
                    confirmation.provenanceKey,
                  )
                : await native.correctSourceObservation(
                    actor,
                    subjectId,
                    provenanceInput.value,
                    confirmation.provenanceKey,
                  );
            input.record?.(command as CommandOutcome<unknown>);
            confirmation.provenanceStatus = 'applied';
            await persist(confirmation);
            for (const selection of actionable)
              result.set(selection.field, { field: selection.field, status: 'applied' });
          } catch (error) {
            if (error instanceof GrantDeniedError) throw error;
            const status = staleEffect(error) ? 'stale' : 'failed';
            if (status === 'stale') {
              confirmation.provenanceStatus = status;
              await persist(confirmation);
            }
            for (const selection of actionable) result.set(selection.field, { field: selection.field, status });
          }
        };
        if (confirmation.provenanceStarted) {
          await runProvenance();
        } else if (!provenanceInput.effect) {
          const current = await native.readPersonalEntry(actor, subjectId),
            annotationInput = confirmation.annotationInput;
          const localMatches =
            current.annotationRevision === (annotationInput?.expectedRevision ?? input.baselineAnnotationRevision) &&
            current.note === (annotationInput?.expectedNote ?? personal.note) &&
            current.priority === (annotationInput?.expectedPriority ?? personal.priority) &&
            entryImportMetadataDigest(current.sourceObservations) === confirmation.sourceObservationDigest;
          confirmation.provenanceStatus = localMatches ? 'applied' : 'stale';
          await persist(confirmation);
          for (const selection of actionable)
            result.set(selection.field, { field: selection.field, status: confirmation.provenanceStatus });
        } else {
          let shouldRun = true;
          if (input.signal?.aborted) {
            shouldRun = false;
            confirmation.provenanceStatus = 'unattempted';
          } else if (await input.isCancelled()) {
            shouldRun = false;
            permanentlyUnattempted = true;
            confirmation.provenanceStatus = 'unattempted';
          } else if (input.isCurrent && !(await input.isCurrent())) {
            shouldRun = false;
            confirmation.provenanceStatus = 'stale';
          } else {
            const current = await native.readPersonalEntry(actor, subjectId),
              annotationInput = confirmation.annotationInput;
            const localMatches =
              current.annotationRevision === (annotationInput?.expectedRevision ?? input.baselineAnnotationRevision) &&
              current.note === (annotationInput?.expectedNote ?? personal.note) &&
              current.priority === (annotationInput?.expectedPriority ?? personal.priority) &&
              entryImportMetadataDigest(current.sourceObservations) === confirmation.sourceObservationDigest;
            if (!localMatches) {
              shouldRun = false;
              confirmation.provenanceStatus = 'stale';
            } else {
              confirmation.provenanceStarted = true;
              await persist(confirmation);
            }
          }
          if (!shouldRun) {
            await persist(confirmation);
            for (const selection of actionable)
              result.set(selection.field, { field: selection.field, status: confirmation.provenanceStatus! });
          } else await runProvenance();
        }
      }
      await persist(confirmation);
    }
  }

  const fields = selections.map(
    (selection) => result.get(selection.field) ?? { field: selection.field, status: 'unsupported' as const },
  );
  const complete =
    !fields.some((field) => field.status === 'failed') &&
    (permanentlyUnattempted || !fields.some((field) => field.status === 'unattempted'));
  const outcome: EntryImportMetadataOutcome = { reviewToken, fields };
  if (complete) {
    confirmation.outcome = outcome;
    await persist(confirmation);
  }
  return { outcome, complete };
}

function staleEffect(error: unknown): boolean {
  return (
    error instanceof LibraryConflictError ||
    error instanceof LibraryNotFoundError ||
    (error instanceof ProblemError && error.code === 'unsupported_library_profile')
  );
}
