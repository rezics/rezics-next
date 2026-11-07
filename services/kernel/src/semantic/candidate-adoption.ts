import {
  beginSemanticRecordSourceSet,
  collectSemanticCandidateSource,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { subjectPageSlot, recordSubjectPageDiff } from './subject-page-publication-native.ts';
import { currentCommand, runCommand } from '../command/command.ts';
import type { Pool } from 'pg';
import type { CandidateAdoptionOptions } from './candidate-contract.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { redirectOf } from './subject-redirect.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { LINK_KEYS_CHANGED, LINKS_CHANGED, SUBJECT_REVISED } from './events.ts';
import { recordPrivacyReduction } from './public-filter-source.ts';
import { factDataTypes, isRelationProperty, SubjectInputError } from './item.ts';
import { holderFacts } from './link-keys.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import { contextSnapshot } from './context.ts';
import registerRelationContext from './relation-context-register.sql';
import listRelationContexts from './relation-context-list.sql';
import changeCurrentFacts from './change-current-facts.sql';
import readAdoptionSubject from './candidates-read-adoption-subject.sql';
import readHiddenIds from './candidates-read-hidden-ids.sql';
import readSlotCandidate from './candidates-read-slot-candidate.sql';
import {
  currentAcceptance,
  expandSlot,
  insertAdoption,
  resolveSlot,
  slotId,
  slotView,
  type Adoption,
} from './slots.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { appendEditorialRevision, retryEditorialUniqueness } from './candidate-command.ts';
import { EditorialConflictError, SubjectNotFoundError } from './contract/subject-errors.ts';

const listed = <T>(result: T[] | T | null): T[] => result == null ? [] : Array.isArray(result) ? result : [result];

export async function adoptCandidates(
  pool: Pool,
  options: CandidateAdoptionOptions,
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const defaults =
    options.context === GLOBAL_CONTEXT ? {} : ((await contextSnapshot(pool, options.context))?.defaults ?? {});
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.adopt',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const sourceSet = await beginSemanticRecordSourceSet(tx);
      const subject = listed(await readAdoptionSubject.run(tx, { route, subject_id: options.subject }))[0];
      if (!subject) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();
      const type = options.release.release.types[subject.type];

      if (options.context === GLOBAL_CONTEXT && options.mode !== 'replace')
        throw new SubjectInputError([{ pointer: '/mode', code: 'unsupported' }]);
      if ((options.mode === 'inherit' || options.mode === 'suppress') && options.selection.length)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const definition = options.release.release.properties[options.property];
      if (!type || !type.properties.includes(options.property) || !definition)
        throw new SubjectInputError([{ pointer: '/property', code: 'unsupported' }]);
      const slot = options.slot ?? slotId(options.subject, options.property);

      if (options.selection.length > 32) throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const hiddenCandidates = new Set<string>();
      const hiddenIds = [
        ...new Set(options.selection.map((entry) => entry.candidate).filter((id) => routeOf(id) === route)),
      ];
      if (hiddenIds.length) {
        const concealed = await readHiddenIds.run(tx, {
          route,
          subject_id: options.subject,
          candidate_ids: hiddenIds,
          viewer_account: '00000000-0000-0000-0000-000000000000',
          viewer_moderator: false,
        });
        for (const row of listed(concealed)) hiddenCandidates.add(row.candidate_id);
      }
      const state = await resolveSlot(tx, options.subject, options.property, options.context, slot);
      const compact = new Set(state.compact.map((candidate) => candidate.candidate_id));
      for (const [index, entry] of options.selection.entries()) {
        let supported = compact.has(entry.candidate);
        if (!supported) {
          const result = await readSlotCandidate.run(tx, {
            route,
            subject_id: options.subject,
            slot_id: slot,
            candidate_id: entry.candidate,
          });
          supported = listed(result).length > 0;
        }
        if (routeOf(entry.candidate) !== route || !supported || hiddenCandidates.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'unsupported' }]);
      }
      for (const entry of options.selection) await collectSemanticCandidateSource(tx, options.subject, entry.candidate);
      const seen = new Set<string>();
      for (const [index, entry] of options.selection.entries()) {
        if (seen.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'invalid_format' }]);
        seen.add(entry.candidate);
      }
      const deprecated = options.selection.findIndex((entry) => entry.rank === 'deprecated');
      if (deprecated >= 0)
        throw new SubjectInputError([{ pointer: `/selection/${deprecated}/rank`, code: 'unsupported' }]);
      if (!definition.multivalued && options.selection.length > 1)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);

      const publicationBefore =
        options.context === GLOBAL_CONTEXT
          ? await subjectPageSlot(
              tx,
              options.subject,
              options.property,
              slot,
              options.release.release,
              options.routeKey,
            )
          : null;
      const beforeFacts = (await slotView(tx, options.subject, options.property, options.context, defaults, slot))
        .facts;
      const globalFacts =
        options.context === GLOBAL_CONTEXT
          ? beforeFacts
          : (await slotView(tx, options.subject, options.property, GLOBAL_CONTEXT, {}, slot)).facts;
      const identity = await holderFacts(tx, options.subject, options.release.release);
      const contextViews = new Map<string, typeof beforeFacts>();
      if (isRelationProperty(options.release.release, options.property)) {
        if (options.context !== GLOBAL_CONTEXT)
          await registerRelationContext.run(tx, {
            route,
            subject_id: options.subject,
            slot_id: slot,
            context_id: options.context,
          });
        else
          for (const row of await listRelationContexts.run(tx, { route, subject_id: options.subject, slot_id: slot }))
            contextViews.set(
              row.context_id,
              (await slotView(tx, options.subject, options.property, row.context_id, {}, slot)).facts,
            );
      }
      let oldGlobalCount = 0;
      if (options.context === GLOBAL_CONTEXT) {
        const global = await resolveSlot(tx, options.subject, options.property, GLOBAL_CONTEXT, slot);
        oldGlobalCount = global.expanded
          ? global.adoption?.mode === 'replace'
            ? global.adoption.selection.length
            : 0
          : global.compact.length;
      }
      await expandSlot(
        tx,
        options.subject,
        options.property,
        transactionId,
        slot,
        isRelationProperty(options.release.release, options.property),
      );
      const revision = subject.revision + 1;
      const selection = options.selection as Adoption['selection'];
      if (options.context === GLOBAL_CONTEXT && !isRelationProperty(options.release.release, options.property)) {
        const newGlobalCount = options.mode === 'replace' ? selection.length : 0;
        const updated = await changeCurrentFacts.run(tx, {
          route,
          subject_id: options.subject,
          delta: newGlobalCount - oldGlobalCount,
        });
        if (updated.length === 0) throw new EditorialConflictError();
      }
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: options.release.digest,
          kind: 'adopt',
          transactionId,
        });
        const head = await insertAdoption(
          tx,
          options.subject,
          options.property,
          options.context,
          options.expectedHead,
          options.mode,
          selection,
          revision,
          slot,
        );
        if (options.context === GLOBAL_CONTEXT) {
          const previous = state.expanded
            ? state.adoption?.mode === 'replace'
              ? state.adoption.selection
              : []
            : state.compact.map((candidate) => ({ candidate: candidate.candidate_id, rank: candidate.rank }));
          const nextRanks = new Map(options.selection.map(({ candidate, rank }) => [candidate, rank]));
          const removed = previous.filter((entry) => nextRanks.get(entry.candidate) !== entry.rank);
          if (removed.length)
            await recordPrivacyReduction(tx, {
              partition: partitionOf(route),
              transactionId,
              time: currentCommand(tx).time,
              cause: 'selection',
              affected: removed.map((entry) => ({
                kind: 'selection' as const,
                route,
                subject: options.subject,
                slot,
                candidate: entry.candidate,
              })),
              impacts: [
                {
                  kind: 'keys',
                  route,
                  subject: options.subject,
                  keys: [{ kind: 'property', property: options.property }],
                },
              ],
            });
        }
        for (const entry of selection) {
          const local = await currentAcceptance(tx, options.subject, entry.candidate, options.context);
          const effective =
            local ??
            (options.context === GLOBAL_CONTEXT
              ? null
              : await currentAcceptance(tx, options.subject, entry.candidate, GLOBAL_CONTEXT));
          if (effective?.verdict !== 'accept') throw new EditorialConflictError();
        }
        const events: { type: string; subject: string; data: unknown }[] = [
          {
            type: SUBJECT_REVISED,
            subject: options.subject,
            data: { id: options.subject, revision, kind: 'adopt' },
          },
        ];
        if (publicationBefore)
          await recordSubjectPageDiff(
            tx,
            options.subject,
            transactionId,
            publicationBefore,
            await subjectPageSlot(
              tx,
              options.subject,
              options.property,
              slot,
              options.release.release,
              options.routeKey,
            ),
            events,
          );
        if (beforeFacts) {
          const afterFacts = (await slotView(tx, options.subject, options.property, options.context, defaults, slot))
            .facts;
          const metadata = {
            subject: options.subject,
            release: options.release.release,
            type: subject.type,
            ...(identity?.facts === undefined ? {} : { identityFacts: identity.facts }),
          };
          const dataTypes = factDataTypes(options.release.release, [...globalFacts, ...beforeFacts, ...afterFacts]);
          const changes =
            options.context === GLOBAL_CONTEXT
              ? linkChanges(beforeFacts, afterFacts, dataTypes, metadata)
              : contextLinkChanges(globalFacts, beforeFacts, afterFacts, dataTypes, metadata, options.context);
          for (const [context, before] of contextViews) {
            const after = (await slotView(tx, options.subject, options.property, context, {}, slot)).facts;
            changes.push(
              ...contextLinkChanges(
                globalFacts,
                before,
                after,
                factDataTypes(options.release.release, [...globalFacts, ...afterFacts, ...before, ...after]),
                metadata,
                context,
                afterFacts,
              ),
            );
          }
          if (changes.length > 0) {
            events.push({
              type: LINKS_CHANGED,
              subject: options.subject,
              data: {
                subject: options.subject,
                revision,
                security_revision: Number(subject.security_revision),
                changes,
              },
            });
          }
          if (options.context === GLOBAL_CONTEXT && options.property === 'schema:datePublished') {
            for (const direction of ['holder', 'target'] as const)
              events.push({
                type: LINK_KEYS_CHANGED,
                subject: options.subject,
                data: {
                  subject: options.subject,
                  direction,
                  revision,
                  security_revision: Number(subject.security_revision),
                  cursor: [],
                },
              });
          }
        }
        await sealSemanticRecordSourceSet(tx, sourceSet);
        await declareCommandHistory(tx, 'subject.adopt', {
          response: { artifactType: 'command-receipt/v1', accounts: [] },
          events: events.map(() => ({ artifactType: 'outbox-event/v1', accounts: [] })),
        });
        return {
          value: {
            adoption: {
              context: options.context,
              property: options.property,
              mode: options.mode,
              selection,
              head,
            },
            revision,
          },
          events,
        };
      } catch (error) {
        retryEditorialUniqueness(error);
        throw error;
      }
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}
