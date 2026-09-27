import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}PackageReleaseRecommendationSetEvent`, action: 'package.recommendation.set',
  type: 'com.rezics.package.recommendations-set.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const operation = value('operation');
    const digest = value('digest');
    if (!receipt || !operation || !digest || value('outcome') !== `${RV}Succeeded`
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(`${operation}\0recommendations`)}`
      || ordinal !== 0 || batch.eventIds.length !== 1) {
      throw new Error('Package recommendation event differs from its source position');
    }
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?main ?revision ?manifest WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:PackageReleaseRecommendationSetEvent ;
        rv:ordinal 0 ; rv:action "package.recommendation.set" ;
        rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ;
        rv:work ?work ; rv:mainVersion ?main . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
        rv:outcome rv:Succeeded ; rv:work ?work ; rv:mainVersion ?main ;
        rv:packageRecommendationRevision ?revision ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:PackageReleaseRecommendationSet ;
        rv:component ?main ; rv:work ?work ; rv:mainVersion ?main ;
        rv:manifest ?manifest ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
        rv:sequence ${batch.sequence} . }
    } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    const work = rows[0]?.work?.value;
    const mainVersion = rows[0]?.main?.value;
    const revision = rows[0]?.revision?.value;
    const manifest = rows[0]?.manifest?.value;
    if (rows.length !== 1 || !work || !mainVersion || !revision
      || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest ?? '')
      || value('work') !== work || value('main') !== mainVersion) {
      throw new Error('Package recommendation event has no unique terminal graph proof');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.package.recommendations-set.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence },
        receipt: { id: receipt, action: 'package.recommendation.set', outcome: 'succeeded',
          requestDigest: digest, admissionId: value('admissionId')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          work, mainVersion, revision, manifest, operation } } };
  },
}];
