import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { PRESENTATION_FAMILY, PRESENTATION_PROFILE_IRI } from './schema.ts';

const eventType = 'com.rezics.lexicon.presentation-changed.v1';
export const outboxEventHandlers: OwnerOutboxEventHandler[] = [
  {
    kind: `${RV}LexiconPresentationChangedEvent`,
    action: 'lexicon.presentation.change',
    type: eventType,
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt'),
        admissionId = value('admissionId'),
        digest = value('digest');
      const authorityEpoch = value('authorityEpoch'),
        scope = value('scope');
      if (
        !receipt ||
        !admissionId ||
        !digest ||
        !authorityEpoch ||
        !scope ||
        !/^[0-9a-f-]{36}$/.test(admissionId) ||
        !/^[0-9a-f]{64}$/.test(digest) ||
        !/^[0-9]+$/.test(authorityEpoch) ||
        receipt !== `urn:rezics:receipt:${hash(`${admissionId}\0${PRESENTATION_FAMILY}`)}` ||
        eventId !== `urn:rezics:event:${hash(`${receipt}\0lexicon-presentation`)}` ||
        batch.batchId !== `urn:rezics:outbox:${hash(receipt)}` ||
        ordinal !== 0 ||
        value('outcome') !== `${RV}Succeeded` ||
        value('epoch') !== batch.dataEpoch ||
        value('sequence') !== batch.sequence
      ) {
        throw new Error('lexicon event differs from its admitted terminal');
      }
      const result =
        await fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?revision ?manifest ?generation ?definition ?meaning ?expected WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:component ?component ; rv:revision ?revision .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?expected } }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:PresentationRevision, rv:RevisionAnchor ;
        rv:component ?component ; rv:manifest ?manifest ; rv:modelGeneration ?generation ;
        rv:presentationDefinition ?definition ; rv:meaningRevision ?meaning ;
        rv:modelRevision ${iri(PRESENTATION_PROFILE_IRI)} ; rv:shapeRevision ${iri(PRESENTATION_PROFILE_IRI)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} } } LIMIT 2`);
      const rows = result.results?.bindings ?? [],
        row = rows[0];
      const component = row?.component?.value,
        revision = row?.revision?.value,
        definition = row?.definition?.value;
      const meaningRevision = row?.meaning?.value,
        manifest = row?.manifest?.value,
        generation = row?.generation?.value;
      const expected = row?.expected?.value;
      const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
      if (
        rows.length !== 1 ||
        !component ||
        !revision ||
        !definition ||
        !meaningRevision ||
        !manifest ||
        !generation ||
        ![component, revision, definition, meaningRevision].every((id) => native.test(id)) ||
        !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest) ||
        !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation) ||
        expected !== value('expectedHead') ||
        (expected !== undefined && !native.test(expected)) ||
        scope !== `semantic:edit:${definition}`
      )
        throw new Error('lexicon event lacks its exact revision proof');
      return {
        specversion: '1.0',
        id: eventId,
        source: 'https://rezics.com/services/main',
        type: eventType,
        datacontenttype: 'application/json',
        data: {
          batchId: batch.batchId,
          sourcePosition: {
            datasetId: 'product',
            dataEpoch: batch.dataEpoch,
            sequence: batch.sequence,
          },
          routingEpoch: batch.routingEpoch,
          ordinal,
          receipt: {
            id: receipt,
            action: 'lexicon.presentation.change',
            outcome: 'succeeded',
            admissionId,
            requestDigest: digest,
            authorityEpoch,
            scope,
            component,
            revision,
            definition,
            meaningRevision,
            manifest,
            modelGeneration: generation,
            ...(expected ? { expectedHead: expected } : {}),
          },
        },
      };
    },
  },
];
