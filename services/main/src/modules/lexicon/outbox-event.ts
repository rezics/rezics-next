import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { readChangedEvent } from '../semantic/outbox-event.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import { PRESENTATION_FAMILY, PRESENTATION_PROFILE_IRI } from './schema.ts';

const eventType = 'com.rezics.lexicon.presentation-changed.v1';
export const outboxEventHandlers: OwnerOutboxEventHandler[] = [
  {
    kind: `${RV}LexiconPresentationChangedEvent`,
    action: 'lexicon.presentation.change',
    actions: ['lexicon.presentation.review'],
    type: eventType,
    read: async (input) => {
      const { fuseki, batch, eventId, value, ordinal } = input;
      const action = value('action'),
        receipt = value('receipt');
      if (
        (action !== 'lexicon.presentation.change' && action !== 'lexicon.presentation.review') ||
        !receipt ||
        eventId !== `urn:rezics:event:${hash(`${receipt}\0semantic-write`)}` ||
        batch.batchId !== `urn:rezics:outbox:${hash(receipt)}` ||
        ordinal !== 0
      ) {
        throw new Error('lexicon event differs from its admitted terminal');
      }
      return readChangedEvent(
        input,
        action,
        PRESENTATION_FAMILY,
        ['PresentationRevision'],
        eventType,
        async (component, revision) => {
          const result =
            await fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?meaning ?status WHERE {
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:PresentationRevision ; rv:component ${iri(component)} ;
            rv:presentationDefinition ?definition ; rv:meaningRevision ?meaning ; rv:reviewStatus ?status ;
            rv:modelRevision ${iri(PRESENTATION_PROFILE_IRI)} ; rv:shapeRevision ${iri(PRESENTATION_PROFILE_IRI)} } } LIMIT 2`);
          const rows = result.results?.bindings ?? [],
            row = rows[0];
          const definition = row?.definition?.value,
            meaningRevision = row?.meaning?.value;
          const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
          if (
            rows.length !== 1 ||
            !definition ||
            !meaningRevision ||
            ![definition, meaningRevision].every((id) => native.test(id)) ||
            row?.status?.value !==
              `${RV}${action === 'lexicon.presentation.review' ? 'Reviewed' : 'Draft'}`
          ) {
            throw new Error('lexicon event lacks its exact meaning proof');
          }
          return { scope: `semantic:edit:${definition}`, fields: { definition, meaningRevision } };
        },
      );
    },
  },
];
