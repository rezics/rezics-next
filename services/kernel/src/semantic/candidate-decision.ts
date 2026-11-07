import {
  beginSemanticRecordSourceSet,
  collectSemanticCandidateSource,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { subjectPageSlot, recordSubjectPageDiff } from './subject-page-publication-native.ts';
import { runCommand } from '../command/command.ts';
import type { Pool } from 'pg';
import type { CandidateDecisionOptions } from './candidate-contract.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { redirectOf } from './subject-redirect.ts';
import { activeRelease, readRelease, layeredRelease } from './definition-release-read.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { termContext } from '@rezics/definitions/extension';
import { LINKS_CHANGED, SUBJECT_REVISED } from './events.ts';
import { factDataTypes, SubjectInputError } from './item.ts';
import { holderFacts } from './link-keys.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import { contextSnapshot } from './context.ts';
import registerRelationContext from './relation-context-register.sql';
import readAdoptionSubject from './candidates-read-adoption-subject.sql';
import readCompactCandidate from './candidates-read-compact-candidate.sql';
import readDecisionCandidate from './candidates-read-decision-candidate.sql';
import readHidden from './candidates-read-hidden.sql';
import {
  currentAcceptance,
  expandSlot,
  insertAcceptance,
  latestAdoption,
  slotView,
} from './slots.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { appendEditorialRevision, retryEditorialUniqueness } from './candidate-command.ts';
import { EditorialConflictError, SubjectNotFoundError } from './contract/subject-errors.ts';

const listed = <T>(result: T[] | T | null): T[] => result == null ? [] : Array.isArray(result) ? result : [result];

export async function decideCandidate(
  pool: Pool,
  options: CandidateDecisionOptions,
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
        kind: 'subject.decide',
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
      type CandidateRow = {
        revision: number;
        release: string;
        candidate_id: string;
        property: string;
        slot_id: string;
        relation: boolean;
      };
      const found = listed(
        await readDecisionCandidate.run(tx, {
          route,
          subject_id: options.subject,
          candidate_id: options.candidate,
        }),
      );
      let candidate: CandidateRow | undefined = found[0];
      if (!candidate) {
        candidate = listed(
          await readCompactCandidate.run(tx, {
            route,
            subject_id: options.subject,
            candidate_id: options.candidate,
          }),
        )[0] as CandidateRow | undefined;
      }
      if (!candidate) throw new SubjectNotFoundError();
      await collectSemanticCandidateSource(tx, options.subject, options.candidate);
      const concealed = await readHidden.run(tx, {
        route,
        subject_id: options.subject,
        candidate_id: options.candidate,
      });
      if (listed(concealed).length > 0) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();
      // A Context's relation type is unknown elsewhere until Global adopts it.
      if (termContext(candidate.property) !== null) {
        const active = await activeRelease(tx);
        const visible = active && (await layeredRelease(tx, active, options.context)).release;
        if (!visible?.properties[candidate.property])
          throw new SubjectInputError([{ pointer: '/candidate', code: 'unsupported' }]);
      }

      const publicationRelease = await readRelease(tx, candidate.release);
      if (!publicationRelease) throw new Error('Candidate release is missing');
      const publicationBefore =
        options.context === GLOBAL_CONTEXT
          ? await subjectPageSlot(
              tx,
              options.subject,
              candidate.property,
              candidate.slot_id,
              publicationRelease,
              options.routeKey,
            )
          : null;
      const release = candidate.relation ? publicationRelease : null;
      const before = release
        ? (await slotView(tx, options.subject, candidate.property, options.context, defaults, candidate.slot_id)).facts
        : [];
      const global = release
        ? (await slotView(tx, options.subject, candidate.property, GLOBAL_CONTEXT, {}, candidate.slot_id)).facts
        : [];
      if (release && options.context !== GLOBAL_CONTEXT)
        await registerRelationContext.run(tx, {
          route,
          subject_id: options.subject,
          slot_id: candidate.slot_id,
          context_id: options.context,
        });
      await expandSlot(tx, options.subject, candidate.property, transactionId, candidate.slot_id, candidate.relation);
      if (options.decision === 'reject') {
        const adoption = await latestAdoption(
          tx,
          options.subject,
          candidate.property,
          options.context,
          candidate.slot_id,
        );
        if (adoption?.mode === 'replace' && adoption.selection.some((entry) => entry.candidate === options.candidate))
          throw new EditorialConflictError();
      }

      const revision = candidate.revision + 1;
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: candidate.release,
          kind: options.decision,
          transactionId,
        });
        const head = await insertAcceptance(
          tx,
          options.subject,
          options.candidate,
          options.context,
          options.expectedHead,
          options.decision,
          revision,
          candidate.slot_id,
        );
        const linkEvents: { type: string; subject: string; data: unknown }[] = [];
        if (publicationBefore)
          await recordSubjectPageDiff(
            tx,
            options.subject,
            transactionId,
            publicationBefore,
            await subjectPageSlot(
              tx,
              options.subject,
              candidate.property,
              candidate.slot_id,
              publicationRelease,
              options.routeKey,
            ),
            linkEvents,
          );
        if (release) {
          const subject = await readAdoptionSubject.run(tx, { route, subject_id: options.subject });
          if (!subject) throw new SubjectNotFoundError();
          const after = (
            await slotView(tx, options.subject, candidate.property, options.context, defaults, candidate.slot_id)
          ).facts;
          const identity = await holderFacts(tx, options.subject, release);
          const metadata = { subject: options.subject, release, type: identity.type, identityFacts: identity.facts };
          const dataTypes = factDataTypes(release, [...global, ...before, ...after]);
          const changes =
            options.context === GLOBAL_CONTEXT
              ? linkChanges(before, after, dataTypes, metadata)
              : contextLinkChanges(global, before, after, dataTypes, metadata, options.context);
          if (changes.length)
            linkEvents.push({
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
        await sealSemanticRecordSourceSet(tx, sourceSet);
        const events = [
          ...linkEvents,
          {
            type: SUBJECT_REVISED,
            subject: options.subject,
            data: { id: options.subject, revision, kind: options.decision },
          },
          {
            type:
              options.decision === 'accept' ? 'com.rezics.statement.accepted.v1' : 'com.rezics.statement.rejected.v1',
            subject: options.subject,
            data: { candidate: options.candidate, context: options.context, revision, head },
          },
        ];
        await declareCommandHistory(tx, 'subject.decide', {
          response: { artifactType: 'command-receipt/v1', accounts: [] },
          events: events.map(() => ({ artifactType: 'outbox-event/v1', accounts: [] })),
        });
        return {
          value: {
            acceptance: {
              context: options.context,
              candidate: options.candidate,
              decision: options.decision,
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
