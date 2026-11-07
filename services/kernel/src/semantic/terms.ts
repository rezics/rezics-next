import type { Pool } from 'pg';
import type { Source } from '@rezics/definitions/bulk';
import { runCommand, noEffect, type CommandAuthorization, type CommandEvent } from '../command/command.ts';
import type { AccessCheck, AccountActor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { initializeRevisionAuthorship } from './authorship.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { SubjectAccessDeniedError, type SubjectComponent } from './subject.ts';
import { fencedIds, sourceTuple, fenceKey } from './fences.ts';
import { SUBJECT_REVISED } from './events.ts';
import { publicState, recordSubjectPageTransition } from './subject-page-publication-store.ts';
import { writeFacts, type StoredFact } from './write-facts.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import {
  beginSemanticRecordSourceSet,
  appendSemanticRecordSourceSet,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import readState from './terms-read-state.sql';
import readSupport from './terms-read-support.sql';
import readCurrent from './terms-read-current.sql';
import insertRevision from './terms-insert-revision.sql';
import writeHeads from './terms-write-heads.sql';
import copyRoles from './terms-copy-roles.sql';
import changeCurrentFacts from './change-current-facts.sql';

const TERM_WRITE_NS = 'c87a7e23-a791-4e5c-9bfe-5448a40b975c';
const absent = { shown: false, digest: null };
function listed<T>(rows: T | T[] | null): T[] {
  return rows === null ? [] : Array.isArray(rows) ? rows : [rows];
}
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
import { SubjectInputError, type Item } from './item.ts';

export type Terms = Pick<Item, 'labels' | 'descriptions' | 'aliases'>;
export type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
export type TermsResult = { subject: string; revision: number };
export type TermChange = { field: keyof Terms; languages: string[] };

const fields = ['labels', 'descriptions', 'aliases'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** A single strong, quoted Subject revision; wildcard, weak and multi-value tags are not CAS. */
export function termRevision(value: string | undefined): number {
  if (!value || !/^"[1-9][0-9]*"$/.test(value))
    throw new SubjectInputError([{ pointer: '/headers/if-match', code: 'invalid_format' }]);
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision) || revision > 2147483647)
    throw new SubjectInputError([{ pointer: '/headers/if-match', code: 'out_of_range' }]);
  return revision;
}

/** Resolve omission and explicit deletion before applying the native final-term limits.
 * The caller supplies authoritative current terms, never a receipt's old Item.
 */
export function patchTerms(current: Terms, input: unknown): { terms: Terms; changes: TermChange[] } {
  if (!object(input)) throw new SubjectInputError([{ pointer: '', code: 'invalid_type' }]);
  const errors: Violation[] = [];
  for (const field of Object.keys(input))
    if (!fields.includes(field as keyof Terms)) errors.push({ pointer: `/${escape(field)}`, code: 'unknown_field' });
  const terms = structuredClone(current);
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const entries = input[field];
    if (!object(entries)) {
      errors.push({ pointer: `/${field}`, code: 'invalid_type' });
      continue;
    }
    for (const [language, value] of Object.entries(entries)) {
      // Validate even deletion keys through the same native language validator.
      const probe = checkSubjectStructure({
        type: '',
        labels: { en: 'Validation' },
        [field]: {
          ...(field === 'labels' ? { en: 'Validation' } : {}),
          [language]: value ?? (field === 'aliases' ? [] : 'Validation'),
        },
      });
      errors.push(...probe.violations);
      const target = terms[field] as Record<string, unknown>;
      if (value === null || (field === 'aliases' && Array.isArray(value) && value.length === 0))
        delete target[language];
      else target[language] = structuredClone(value);
    }
  }
  if (errors.length) throw new SubjectInputError(errors.slice(0, 16));
  const checked = checkSubjectStructure({ type: '', ...terms });
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const changes = fields.flatMap((field) => {
    const before = current[field] as Record<string, unknown>;
    const after = terms[field] as Record<string, unknown>;
    const languages = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((language) => JSON.stringify(before[language]) !== JSON.stringify(after[language]))
      .sort();
    return languages.length ? [{ field, languages }] : [];
  });
  return { terms, changes };
}

export class StaleTermsRevisionError extends Error {}

/** One Subject partition; the supplied creation authorization retains its real Global
 * parent proof, Actor and scopes. Eligibility is checked again before every receipt.
 */
export async function correctTerms(
  pool: Pool,
  input: {
    subject: string;
    expectedRevision: number;
    patch: unknown;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    authorization: CommandAuthorization;
    noEffectAuthorization: CommandAuthorization;
    prepareSubject: () => Promise<AccessCheck>;
    routeKey: Uint8Array;
    deadline: number;
    clock?: () => Date;
  },
): Promise<TermsResult & { component: SubjectComponent; replayed: boolean }> {
  const route = routeOf(input.subject);
  if (route === null) throw new SubjectNotFoundError();
  const parameters = { route, subject_id: input.subject };
  const patch = structuredClone(input.patch);
  const authorization = input.authorization;
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: input.deadline,
      receipt: {
        actorAccountId: input.actor.accountId,
        kind: 'subject.terms',
        key: input.idempotencyKey,
        digest: input.digest,
      },
      basis: {
        actorAccountId: input.actor.accountId,
        clientId: input.actor.clientId,
        requestedBy: input.actor.requestedBy,
      },
      authorization: {
        ...authorization,
        async prepare(attempt) {
          return {
            creation: await authorization.prepare?.(attempt),
            proposal: await input.noEffectAuthorization.prepare?.(attempt),
            subject: await input.prepareSubject(),
            changed: true,
          };
        },
        async authorize(tx, attempt, evidence) {
          const proof = evidence as { creation: unknown; proposal: unknown; subject: AccessCheck; changed: boolean };
          const state = await readState.run(tx, parameters);
          if (!state || state.visibility !== 'visible' || state.redirect || !(await proof.subject(tx, attempt.time)))
            throw new SubjectNotFoundError();
          if (state.derived) throw new SubjectAccessDeniedError();
          // Withheld imported terms cannot be read, rewritten, or laundered into an
          // ordinary term. Fresh checks also precede receipt disclosure on replay.
          const current = listed(await readCurrent.run(tx, parameters));
          const support = listed(await readSupport.run(tx, { ...parameters, entries: patchEntries(patch) }));
          if (
            (
              await fencedIds(
                tx,
                input.routeKey,
                [...current, ...support].map((row, index) => ({
                  id: String(index),
                  source: row.source as Source | null,
                })),
              )
            ).size
          )
            throw new SubjectNotFoundError();
          try {
            proof.changed = patchTerms(termsOf(current), patch).changes.length > 0;
          } catch {
            proof.changed = true;
          } // The body reports validation after receipt lookup.
          await (proof.changed ? authorization : input.noEffectAuthorization).authorize(
            tx,
            attempt,
            proof.changed ? proof.creation : proof.proposal,
          );
          return 'execute';
        },
        async finalize(tx, attempt, evidence) {
          const proof = evidence as { creation: unknown; proposal: unknown; changed: boolean };
          const selected = proof.changed ? authorization : input.noEffectAuthorization;
          await selected.finalize?.(tx, attempt, proof.changed ? proof.creation : proof.proposal);
        },
      },
      clock: input.clock,
    },
    async (tx, { transactionId }) => {
      const state = await readState.run(tx, parameters);
      if (!state || state.revision === null) throw new SubjectNotFoundError();
      if (state.revision !== input.expectedRevision) throw new StaleTermsRevisionError();
      const current = listed(await readCurrent.run(tx, parameters));
      const terms = termsOf(current);
      const patched = patchTerms(terms, patch);
      if (!patched.changes.length) return noEffect({ subject: input.subject, revision: state.revision });
      if (state.revision >= 2147483647)
        throw new SubjectInputError([{ pointer: '/headers/if-match', code: 'out_of_range' }]);
      const revision = state.revision + 1;
      const kinds = { labels: 'label', descriptions: 'description', aliases: 'alias' } as const;
      const changed = (kind: string, language: string) =>
        patched.changes.some((change) => kinds[change.field] === kind && change.languages.includes(language));
      const oldRows = current.filter((row) => changed(row.kind!, row.language!));
      const facts: StoredFact[] = [];
      const heads = patched.changes.flatMap((change) =>
        change.languages.map((language) => {
          const kind = kinds[change.field];
          const slot = derivedId(TERM_WRITE_NS, `${input.subject}\n${revision}\n${kind}\n${language}`, route);
          const value = patched.terms[change.field][language];
          const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
          values.forEach((body, index) =>
            facts.push({
              slot_id: slot,
              log_seq: index + 1,
              operation: 'assert',
              kind,
              language,
              property: null,
              statement_id: null,
              body,
              release: null,
            }),
          );
          return { kind, language, slot_id: slot, active: values.length > 0 };
        }),
      );
      const delta = facts.length - oldRows.length;
      const sourceSet = await beginSemanticRecordSourceSet(tx);
      if (!(await changeCurrentFacts.run(tx, { ...parameters, delta })))
        throw new SubjectInputError([{ pointer: '', code: 'out_of_range' }]);
      const support = listed(await readSupport.run(tx, { ...parameters, entries: heads }));
      await insertRevision.run(tx, {
        ...parameters,
        revision,
        release: state.release,
        transaction_id: transactionId,
        changes: patched.changes,
        support: [...new Set(support.map((row) => row.revision))],
      });
      // Real revision insertion is the prerequisite for the existing producer.
      await initializeRevisionAuthorship(tx, { subject: input.subject, revision });
      await copyRoles.run(tx, {
        partition_no: partitionOf(route),
        transaction_id: transactionId,
        keys: oldRows.map((row) => row.erasure_key!),
      });
      // Switch heads before inserting facts: their capture trigger may only initialize
      // original heads, never lose an imported head's immutable Source support.
      await writeHeads.run(tx, { ...parameters, transaction_id: transactionId, heads });
      await writeFacts(tx, { ...parameters, transaction_id: transactionId, facts });
      await appendSemanticRecordSourceSet(tx, sourceSet, {
        sources: [],
        terms: patched.changes.flatMap((change) =>
          change.languages.flatMap((language) => {
            const original = oldRows.find((row) => row.kind === kinds[change.field] && row.language === language);
            const originalRevision = original?.support_revision ?? null;
            // Deletion has no new fact. Keep its genuine native support only.
            const currentRevision = patched.terms[change.field][language] === undefined ? originalRevision : revision;
            return currentRevision === null
              ? []
              : [{ subjectId: input.subject, originalRevision, currentRevision, field: change.field, language }];
          }),
        ),
      });
      // Inactive imported heads can still supply original provenance on restoration.
      await appendSemanticRecordSourceSet(tx, sourceSet, {
        sources: [],
        terms: support.map((row) => ({
          subjectId: input.subject,
          originalRevision: null,
          currentRevision: row.revision,
          field: row.kind === 'label' ? 'labels' : row.kind === 'description' ? 'descriptions' : 'aliases',
          language: row.language,
        })),
      });
      await sealSemanticRecordSourceSet(tx, sourceSet);
      const events: CommandEvent[] = [
        { type: SUBJECT_REVISED, subject: input.subject, data: { id: input.subject, revision, kind: 'terms' } },
      ];
      const labelChanges = patched.changes.find((change) => change.field === 'labels');
      await recordSubjectPageTransition(tx, {
        subject: { route, id: input.subject },
        changeId: transactionId,
        outbox: events,
        components: (labelChanges?.languages ?? []).map((language) => {
          const original = oldRows.find((row) => row.kind === 'label' && row.language === language);
          const source = (original?.source ??
            support.find((row) => row.kind === 'label' && row.language === language)?.source) as
            | Source
            | null
            | undefined;
          const tuple = source && 'source' in source ? sourceTuple(input.routeKey, source) : null;
          return {
            component: { kind: 'label', key: language },
            before: terms.labels[language] === undefined ? absent : publicState(terms.labels[language]),
            after: patched.terms.labels[language] === undefined ? absent : publicState(patched.terms.labels[language]),
            dependencies: tuple ? [{ kind: 'source-fence', route: tuple.route, key: fenceKey(tuple) }] : [],
          };
        }),
      });
      await declareCommandHistory(tx, 'subject.terms', {
        response: { artifactType: 'command-receipt/v1', accounts: [] },
        events: events.map(() => ({ artifactType: 'outbox-event/v1', accounts: [] })),
      });
      return { value: { subject: input.subject, revision }, events };
    },
  );
  return {
    ...command.value,
    replayed: command.replayed,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

function termsOf(rows: { kind: string | null; language: string | null; body: unknown }[]): Terms {
  const terms: Terms = { labels: {}, descriptions: {}, aliases: {} };
  for (const row of rows) {
    if (row.kind === 'label') terms.labels[row.language!] = row.body as string;
    else if (row.kind === 'description') terms.descriptions[row.language!] = row.body as string;
    else if (row.kind === 'alias') (terms.aliases[row.language!] ??= []).push(row.body as string);
  }
  return terms;
}

function patchEntries(input: unknown): { kind: string; language: string }[] {
  if (!object(input)) return [];
  const kinds = { labels: 'label', descriptions: 'description', aliases: 'alias' } as const;
  return fields.flatMap((field) =>
    object(input[field]) ? Object.keys(input[field]).map((language) => ({ kind: kinds[field], language })) : [],
  );
}
