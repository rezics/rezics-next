import { expect } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';

const rv = 'https://rezics.com/vocab/';
const id = (suffix: number) => `https://rezics.com/id/019cb49e-0ea2-7000-8000-0000000007${String(suffix).padStart(2, '0')}`;
const realm = id(1), context = id(2), work = id(3), main = id(4), release = id(5);
const observation = id(6), revision = id(7), mainContext = id(8), prior = id(9);
const slot = `urn:rezics:rating-slot:${'c'.repeat(64)}`;
const time = '2026-09-27T03:00:00Z';
const graphs = { current: 'urn:rezics:graph:current', revisions: 'urn:rezics:graph:revisions',
  control: 'urn:rezics:graph:control', receipts: 'urn:rezics:graph:receipts', outbox: 'urn:rezics:graph:outbox' };
const dataset = 'urn:rezics:dataset:product';
const policy = (name: string) => `<https://rezics.com/definition/${name}>`;
const contextTriples = (subject: string, type: string, grain: string) => `<${subject}> a rv:${type} ;
  rv:contextState rv:Active ; rv:realm <${realm}> ; rv:question "Edition quality"@en ;
  rv:targetGrain rv:${grain} ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
  rv:ratingCadence ${policy('rating-standing-v1')} ;
  rv:ratingPopulationPolicy ${policy('rating-account-principal-population-v1')} ;
  rv:ratingAggregationPolicy ${policy('rating-latest-per-rater-mean-v1')} .`;
const observationTriples = `<${observation}> a rv:ReleaseRatingObservation ; rv:ratingContext <${context}> ;
  rv:targetRelease <${release}> ; rv:ratingSlot <${slot}> ; rv:observationHead <${revision}> .`;
const revisionTriples = `<${revision}> a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
  rv:component <${observation}> ; rv:observation <${observation}> ; rv:ratingAvailability rv:Available ;
  rv:ratingValue 7 ; rv:evaluatedAt "${time}"^^xsd:dateTime ; rv:submittedAt "${time}"^^xsd:dateTime ;
  rv:originalSubmissionAt "${time}"^^xsd:dateTime ; rv:revisedAt "${time}"^^xsd:dateTime .`;
const observationBinding: Record<string, string> = { realm, context, work, main, release, slot,
  observation, revision, availability: 'available', value: '7' };

interface Variant {
  name: string;
  /** Pre-existing dependencies, not touched by the command. */
  current: string; revisions: string;
  /** Product subjects the command writes; the module routes each by its canonical type. */
  insertCurrent: string; insertRevisions?: string;
  profile: keyof typeof profileRegistry;
  focus: Record<string, string>;
  binding: Record<string, string>;
  expected: 'committed' | 'invalid' | 'bad-request';
}

const dependencies = `<${realm}> a rv:Realm ; rv:realmState rv:Active ;
  rv:ratingContext <${context}>, <${mainContext}> .
  ${contextTriples(mainContext, 'RatingContext', 'MainVersion')}
  <${work}> a schema:CreativeWork ; rv:mainVersion <${main}> .
  <${main}> a rv:MainVersion ; rv:work <${work}> .`;
const sealedRelease = `<${release}> a rv:FixedRelease ; rv:work <${work}> ; rv:mainVersion <${main}> .`;
const observationFocus = { realm, context, work, main, release, observation, revision };
const contextFocus = { realm, context };
const observationVariant = (name: string, change: Partial<Variant>, expected: Variant['expected'] = 'invalid'): Variant => ({
  name, current: `${dependencies}\n${contextTriples(context, 'ReleaseRatingContext', 'FixedRelease')}`,
  revisions: sealedRelease, insertCurrent: observationTriples, insertRevisions: revisionTriples,
  profile: 'realm-release-rating-observation-v1', focus: observationFocus, binding: observationBinding,
  expected, ...change,
});
const contextVariant = (name: string, change: Partial<Variant>, expected: Variant['expected'] = 'invalid'): Variant => ({
  name, current: dependencies, revisions: '',
  insertCurrent: contextTriples(context, 'ReleaseRatingContext', 'FixedRelease'),
  profile: 'realm-release-rating-context-v1', focus: contextFocus,
  binding: { realm, context, question: 'Edition quality' }, expected, ...change,
});

const variants: Variant[] = [
  contextVariant('context-valid', {}, 'committed'),
  contextVariant('context-mainversion-grain', {
    insertCurrent: contextTriples(context, 'ReleaseRatingContext', 'MainVersion') }),
  contextVariant('context-also-mainversion-type', {
    insertCurrent: `${contextTriples(context, 'ReleaseRatingContext', 'FixedRelease')}
      <${context}> a rv:RatingContext .` }),
  contextVariant('context-daily-time-zone', {
    insertCurrent: `${contextTriples(context, 'ReleaseRatingContext', 'FixedRelease')}
      <${context}> rv:ratingTimeZone "UTC" .` }),
  // A release-typed Context cannot be admitted through the MainVersion profile's binding.
  contextVariant('context-bound-as-standing', { profile: 'realm-standing-rating-context-v1' }),
  observationVariant('observation-valid', {}, 'committed'),
  observationVariant('observation-withdrawal-retains-value', {
    insertRevisions: revisionTriples.replace('rv:Available', 'rv:Withdrawn') }),
  observationVariant('observation-valid-withdrawal', {
    insertRevisions: revisionTriples.replace('rv:Available ;\n  rv:ratingValue 7 ;', 'rv:Withdrawn ;'),
    binding: Object.fromEntries(Object.entries({ ...observationBinding, availability: 'withdrawn' })
      .filter(([key]) => key !== 'value')) }, 'committed'),
  observationVariant('observation-valid-correction', {
    revisions: `${sealedRelease}\n<${prior}> a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
      rv:observation <${observation}> .`,
    insertRevisions: revisionTriples.replace('rv:ratingValue 7 ;', `rv:ratingValue 7 ; rv:predecessor <${prior}> ;`),
    binding: { ...observationBinding, predecessor: prior } }, 'committed'),
  observationVariant('observation-also-targets-mainversion', {
    insertCurrent: `${observationTriples}\n<${observation}> rv:targetMainVersion <${main}> .` }),
  observationVariant('observation-without-release', {
    insertCurrent: observationTriples.replace(`rv:targetRelease <${release}> ;`, '') }),
  observationVariant('observation-targets-mainversion-as-release', {
    insertCurrent: observationTriples.replace(`rv:targetRelease <${release}>`, `rv:targetRelease <${main}>`) }),
  observationVariant('observation-in-mainversion-context', {
    insertCurrent: observationTriples.replace(`rv:ratingContext <${context}>`, `rv:ratingContext <${mainContext}>`),
    focus: { ...observationFocus, context: mainContext }, binding: { ...observationBinding, context: mainContext } }),
  observationVariant('observation-unsealed-release', { revisions: '' }),
  observationVariant('observation-release-of-no-mainversion', {
    revisions: `<${release}> a rv:FixedRelease ; rv:work <${work}> .` }),
  observationVariant('observation-daily-period', {
    insertCurrent: `${observationTriples}\n<${observation}> rv:ratingDay "2026-09-27" .` }),
  observationVariant('observation-missing-release-binding', {
    binding: Object.fromEntries(Object.entries(observationBinding).filter(([key]) => key !== 'release')) }, 'bad-request'),
  observationVariant('observation-release-focus-differs', {
    binding: { ...observationBinding, release: main } }, 'bad-request'),
  // A release-typed opinion cannot be admitted through the MainVersion profile.
  observationVariant('observation-bound-as-standing', {
    profile: 'realm-standing-rating-observation-v1',
    focus: { realm, context, work, main, observation, revision },
    binding: Object.fromEntries(Object.entries(observationBinding).filter(([key]) => key !== 'release')) }),
  // A MainVersion-typed opinion cannot target the release Context either.
  observationVariant('mainversion-observation-in-release-context', {
    insertCurrent: `<${observation}> a rv:RatingObservation ; rv:ratingContext <${context}> ;
      rv:targetMainVersion <${main}> ; rv:ratingSlot <${slot}> ; rv:observationHead <${revision}> .`,
    insertRevisions: revisionTriples.replace('a rv:ReleaseRatingObservationRevision,', 'a rv:RatingObservationRevision,'),
    profile: 'realm-standing-rating-observation-v1',
    focus: { realm, context, work, main, observation, revision },
    binding: Object.fromEntries(Object.entries(observationBinding).filter(([key]) => key !== 'release')) }),
];

export async function validateReleaseRatingNativeShapes(
  fusekiUrl: string, commandToken: string): Promise<void> {
  const base = fusekiUrl.replace(/\/$/, '');
  const prefixes = `PREFIX rv: <${rv}> PREFIX schema: <https://schema.org/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;
  const update = async (sparql: string) => {
    const response = await fetch(`${base}/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' }, body: sparql });
    if (!response.ok) throw new Error(`model fixture ${response.status}: ${await response.text()}`);
  };
  const ask = async (sparql: string) => {
    const response = await fetch(`${base}/query?query=${encodeURIComponent(sparql)}`,
      { headers: { accept: 'application/sparql-results+json' } });
    return (await response.json() as { boolean: boolean }).boolean;
  };
  const outcomes: Record<string, string> = {};
  for (const variant of variants) {
    const nonce = crypto.randomUUID(), receipt = `urn:release-rating-model:${nonce}`;
    await update(Object.values(graphs).map(graph => `CLEAR SILENT GRAPH <${graph}>`).join(';\n'));
    await update(`${prefixes} INSERT DATA {
      GRAPH <${graphs.current}> { ${variant.current} }
      GRAPH <${graphs.revisions}> { ${variant.revisions} }
      GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch "${nonce}" ; rv:routingEpoch "1" ; rv:sequence 0 . } }`);
    const pinned = profileRegistry[variant.profile];
    const validations = pinned.shapes.map(shape => {
      const role = shape.split('/').at(-1)!.replace(/-shape$/, '');
      return { profile: variant.profile, sha256: pinned.sha256, shape, focus: [variant.focus[role]!],
        graphs: [graphs.current, graphs.revisions], binding: variant.binding };
    });
    const response = await fetch(`${base}/command`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${commandToken}` },
      body: JSON.stringify({ receipt, digest: nonce, deadlineMs: 10_000, validations,
        update: `${prefixes}
          DELETE { GRAPH <${graphs.control}> { <${dataset}> rv:sequence 0 } }
          INSERT { GRAPH <${graphs.control}> { <${dataset}> rv:sequence 1 }
            GRAPH <${graphs.current}> { ${variant.insertCurrent} }
            GRAPH <${graphs.revisions}> { ${variant.insertRevisions ?? ''} }
            GRAPH <${graphs.receipts}> { <${receipt}> a rv:OperationReceipt ; rv:requestDigest "${nonce}" ;
              rv:datasetId <${dataset}> ; rv:dataEpoch "${nonce}" ; rv:sequence 1 ; rv:outcome rv:Succeeded . }
            GRAPH <${graphs.outbox}> { <${receipt}:batch> a rv:OutboxBatch ; rv:dataEpoch "${nonce}" ;
              rv:sequence 1 ; rv:eventCount 1 ; rv:event <${receipt}:event> .
              <${receipt}:event> a rv:${variant.profile.includes('observation')
                ? 'RatingObservationChangedEvent' : 'RatingContextCreatedEvent'} ;
                rv:ordinal 0 ; rv:receipt <${receipt}> . }
          } WHERE { GRAPH <${graphs.control}> { <${dataset}> rv:sequence 0 ; rv:dataEpoch "${nonce}" ; rv:routingEpoch "1" . }
            FILTER NOT EXISTS { GRAPH <${graphs.receipts}> { <${receipt}> ?p ?o } } }` }) });
    const result = await response.json() as { status: string; report?: string };
    outcomes[variant.name] = result.status;
    if (result.status !== variant.expected) console.error(`${variant.name}: ${JSON.stringify(result).slice(0, 600)}`);
    // A rejected command leaves no product, receipt or sequence change behind.
    expect(await ask(`ASK { GRAPH <${graphs.receipts}> { <${receipt}> ?p ?o } }`)).toBe(variant.expected === 'committed');
    expect(await ask(`ASK { GRAPH <${graphs.control}> { <${dataset}> <${rv}sequence> ${
      variant.expected === 'committed' ? 1 : 0} } }`)).toBe(true);
  }
  expect(outcomes).toEqual(Object.fromEntries(variants.map(variant => [variant.name, variant.expected])));
}
