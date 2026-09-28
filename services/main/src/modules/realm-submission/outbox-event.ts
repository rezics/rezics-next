import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { realmSelectionReceiptIri } from '../work/select-realm.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}RealmSubmissionSelectedEvent`, action: 'submission.submit',
  type: 'com.rezics.realm.submission-selected.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt');
    const admission = value('admissionId');
    const realm = value('realm');
    const operation = value('operation');
    const references = Object.fromEntries(['work', 'main', 'slot', 'contribution',
      'publicationDecision', 'selectedDraft', 'selection', 'matchUnit', 'language']
      .map(name => [name, value(name)]));
    if (!receipt || !admission || !realm || !operation
      || Object.values(references).some(reference => !reference)
      || receipt !== realmSelectionReceiptIri(admission, true)
      || eventId !== `urn:rezics:event:${hash(operation)}` || value('eventRealm') !== realm
      || value('eventOperation') !== operation || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || value('scope') !== `submission:submit:${realm}` || !value('authorityEpoch') || !value('digest')) {
      throw new Error('Automatic adoption event differs');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?selection ?policy ?draft ?manifest ?actor ?reviewPolicy WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:selection ?selection ; rv:selectedDraft ?draft . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:context ${iri(realm)} ;
        rv:selectionBasis rv:RealmPolicy ; rv:realmPolicyHead ?policy ; rv:selectedDraft ?draft ;
        rv:manifest ?manifest ; rv:submittingAgent ?actor ; rv:reviewPolicy ?reviewPolicy ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.selection || !rows[0].policy || !rows[0].draft) {
      throw new Error('Automatic adoption revision is incomplete');
    }
    const row = rows[0];
    if (row.selection!.value !== references.selection || row.draft!.value !== references.selectedDraft
      || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(row.manifest?.value ?? '')
      || !row.actor || !row.reviewPolicy) throw new Error('Automatic adoption replay basis is incomplete');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.realm.submission-selected.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'submission.submit', outcome: 'succeeded', requestDigest: value('digest')!,
          admissionId: admission, authorityEpoch: value('authorityEpoch')!, scope: value('scope')!, realm,
          operation, ...references, mainVersion: references.main,
          ...(value('expectedHead') ? { expectedHead: value('expectedHead') } : {}),
          selectionManifest: row.manifest!.value, submittingAgent: row.actor.value,
          reviewPolicy: row.reviewPolicy.value, policyRevision: row.policy!.value } } };
  },
}, {
  kind: `${RV}RealmResourceSelectedEvent`, action: 'publication.adopt', actions: ['submission.submit'],
  type: 'com.rezics.realm.resource-selected.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt'), admissionId = value('admissionId'), scope = value('scope');
    const action = scope?.startsWith('submission:submit:') ? 'submission.submit' : 'publication.adopt';
    if (!receipt || !admissionId || !scope || !value('digest') || !value('authorityEpoch')
      || value('outcome') !== `${RV}Succeeded` || value('epoch') !== batch.dataEpoch
      || value('sequence') !== batch.sequence || eventId !== `urn:rezics:event:${hash(receipt)}`) {
      throw new Error('Resource adoption event differs from receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?selection ?slot ?realm ?work ?manifest WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:RealmResourceSelectedEvent ;
        rv:receipt ${iri(receipt)} ; rv:action ${lit(action)} ; rv:component ?slot ; rv:revision ?selection . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:RealmSubmissionSelection ; rv:component ?slot ;
        rv:context ?realm ; rv:work ?work ; rv:manifest ?manifest ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.selection || !row.slot || !row.realm || !row.work || !row.manifest
      || scope !== `${action === 'submission.submit' ? 'submission:submit' : 'publication:adopt'}:${row.realm.value}`) {
      throw new Error('Resource adoption revision is incomplete');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.realm.resource-selected.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action, outcome: 'succeeded', admissionId, scope,
          requestDigest: value('digest')!, authorityEpoch: value('authorityEpoch')!,
          selection: row.selection.value, slot: row.slot.value, realm: row.realm.value,
          work: row.work.value, selectionManifest: row.manifest.value } } };
  },
}];
