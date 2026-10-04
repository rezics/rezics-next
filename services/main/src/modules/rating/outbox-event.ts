import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { readChangedEvent } from '../semantic/outbox-event.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import {
  QUESTION_PRESENTATION_ACTIONS,
  QUESTION_PRESENTATION_FAMILY,
  QUESTION_PRESENTATION_REVISION_PROFILES,
  questionPresentationScope,
} from './question-presentation-schema.ts';

const eventType = 'com.rezics.rating.question-presentation-changed.v1';
export const outboxEventHandlers: OwnerOutboxEventHandler[] = [
  {
    kind: `${RV}RatingQuestionPresentationChangedEvent`,
    action: QUESTION_PRESENTATION_ACTIONS[0],
    actions: [QUESTION_PRESENTATION_ACTIONS[1]],
    type: eventType,
    read: async (input) => {
      const { fuseki, batch, eventId, value, ordinal } = input;
      const action = value('action'),
        receipt = value('receipt');
      if (
        !QUESTION_PRESENTATION_ACTIONS.some((candidate) => candidate === action) ||
        !receipt ||
        eventId !== `urn:rezics:event:${hash(`${receipt}\0semantic-write`)}` ||
        batch.batchId !== `urn:rezics:outbox:${hash(receipt)}` ||
        ordinal !== 0
      ) {
        throw new Error('Rating presentation event differs from its admitted terminal');
      }
      return readChangedEvent(
        input,
        action === QUESTION_PRESENTATION_ACTIONS[0]
          ? QUESTION_PRESENTATION_ACTIONS[0]
          : QUESTION_PRESENTATION_ACTIONS[1],
        QUESTION_PRESENTATION_FAMILY,
        ['RatingQuestionPresentationRevision', 'RatingQuestionPresentationV2Revision'],
        eventType,
        async (component, revision) => {
          const rows =
            (
              await fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?status WHERE {
          ${QUESTION_PRESENTATION_REVISION_PROFILES}
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a ?presentationRevisionKind ;
            rv:component ${iri(component)} ; rv:presentationContext ?context ; rv:reviewStatus ?status ;
            rv:modelRevision ?presentationProfile ; rv:shapeRevision ?presentationProfile }
        } LIMIT 2`)
            ).results?.bindings ?? [];
          const context = rows[0]?.context?.value;
          if (
            rows.length !== 1 ||
            !context ||
            !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(context) ||
            rows[0]?.status?.value !==
              `${RV}${action === QUESTION_PRESENTATION_ACTIONS[1] ? 'Reviewed' : 'Draft'}`
          ) {
            throw new Error('Rating presentation event lacks its exact Context proof');
          }
          return { scope: questionPresentationScope(context), fields: { context } };
        },
      );
    },
  },
];
