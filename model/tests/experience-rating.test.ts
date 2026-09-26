import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { realmStandingRatingObservationFixture } from './fixtures/native/realm-standing-rating-observation.ts';
import { realmStandingRatingContextFixture } from './fixtures/native/realm-standing-rating-context.ts';

test('RATE02/MODEL17: experience shapes bind occasion predecessor and immutable evaluation times', async () => {
  if (!Bun.env.FUSEKI_URL || !Bun.env.MODEL_NATIVE_EQUIVALENCE) throw new Error('Run through the native model tier');
  const base = Bun.env.FUSEKI_URL.replace(/\/$/, ''), rv = 'https://rezics.com/vocab/';
  const current = 'urn:rezics:graph:current', control = 'urn:rezics:graph:control';
  const receipts = 'urn:rezics:graph:receipts', outbox = 'urn:rezics:graph:outbox';
  const dataset = 'urn:rezics:dataset:product', occasion = `urn:rezics:rating-occasion:${'a'.repeat(64)}`;
  const initialTime = '2026-09-24T03:00:00Z', editTime = '2026-09-24T04:00:00Z';
  const update = async (sparql: string) => {
    const response = await fetch(`${base}/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' }, body: sparql });
    if (!response.ok) throw new Error(`model fixture ${response.status}: ${await response.text()}`);
  };
  const observation = realmStandingRatingObservationFixture.cases['valid-create'];
  const context = Object.values(realmStandingRatingContextFixture.cases).find(candidate => candidate.expected)!;
  for (const [kind, candidate] of [['context', context], ['observation', observation]] as const) {
    const profile = `realm-experience-rating-${kind}-v1` as const;
    const binding: Record<string, string> = { ...candidate.args,
      ...(kind === 'observation' ? { occasion } : {}) };
    const source = candidate.turtle.replaceAll('rating-standing-v1', 'rating-experience-v1')
      .replaceAll('a rv:RatingContext ;', 'a rv:RatingContext, rv:ExperienceRatingContext ;')
      .replaceAll('a rv:RatingObservation ;', `a rv:RatingObservation, rv:ExperienceRatingObservation ; rv:ratingOccasion <${occasion}> ;`)
      .replaceAll('a rv:RatingObservationRevision ;', `a rv:RatingObservationRevision, rv:ExperienceRatingObservationRevision ; rv:ratingOccasion <${occasion}> ;`);
    const predecessor = 'urn:experience-model:prior';
    const correction = source.replace(`rv:ratingValue 7`, `rv:ratingValue 8 ; rv:predecessor <${predecessor}>`)
      .replace(`rv:submittedAt "${initialTime}"`, `rv:submittedAt "${editTime}"`)
      .replace(`rv:revisedAt "${initialTime}"`, `rv:revisedAt "${editTime}"`)
      + `\n<${predecessor}> a rv:RatingObservationRevision ; rv:observation <${candidate.args.observation}> ;
        rv:ratingOccasion <${occasion}> ; rv:evaluatedAt "${initialTime}"^^xsd:dateTime ;
        rv:originalSubmissionAt "${initialTime}"^^xsd:dateTime .`;
    const correctionBinding = { ...binding, predecessor, value: '8' };
    const withdrawal = correction.replace('rv:ratingValue 8 ; ', '').replace('rv:ratingAvailability rv:Available', 'rv:ratingAvailability rv:Withdrawn');
    const { value: _value, ...withoutValue } = correctionBinding;
    const variants = [
      { name: 'valid', source, binding, expected: 'committed' },
      { name: 'wrong-cadence', source: source.replaceAll('rating-experience-v1', 'rating-standing-v1'), binding, expected: 'invalid' },
      { name: 'missing-context-type', source: source.replaceAll(', rv:ExperienceRatingContext', ''), binding, expected: 'invalid' },
      ...(kind === 'observation' ? [
        { name: 'valid-correction', source: correction, binding: correctionBinding, expected: 'committed' },
        { name: 'valid-withdrawal', source: withdrawal, binding: { ...withoutValue, availability: 'withdrawn' }, expected: 'committed' },
        { name: 'withdrawal-retains-value', source: correction, binding: { ...withoutValue, availability: 'withdrawn' }, expected: 'invalid' },
        { name: 'missing-occasion', source: source.replaceAll(`rv:ratingOccasion <${occasion}> ;`, ''), binding, expected: 'invalid' },
        { name: 'available-without-value', source: source.replace(' ; rv:ratingValue 7', ''), binding, expected: 'invalid' },
        { name: 'wrong-slot-binding', source, binding: { ...binding, slot: `urn:rezics:rating-slot:${'b'.repeat(64)}` }, expected: 'invalid' },
        { name: 'wrong-occasion-binding', source, binding: { ...binding, occasion: `urn:rezics:rating-occasion:${'b'.repeat(64)}` }, expected: 'invalid' },
        { name: 'public-raw-marker', source: source.replaceAll(occasion, 'urn:uuid:6bccd32c-c4bb-41a8-8c6e-eeb3a17b9ef1'), binding, expected: 'invalid' },
        { name: 'invented-predecessor', source, binding: { ...binding, predecessor }, expected: 'invalid' },
        { name: 'another-predecessor-occasion', source: correction.replace(`<${predecessor}> a rv:RatingObservationRevision ; rv:observation`,
          `<${predecessor}> rv:ratingOccasion <urn:wrong:occasion> ; a rv:RatingObservationRevision ; rv:observation`).replace(`rv:ratingOccasion <${occasion}> ; rv:evaluatedAt`, 'rv:evaluatedAt'), binding: correctionBinding, expected: 'invalid' },
        { name: 'another-predecessor-observation', source: correction.replace(`<${predecessor}> a rv:RatingObservationRevision ; rv:observation <${candidate.args.observation}>`,
          `<${predecessor}> a rv:RatingObservationRevision ; rv:observation <urn:wrong:observation>`), binding: correctionBinding, expected: 'invalid' },
        { name: 'changed-evaluation', source: correction.replace(`rv:evaluatedAt "${initialTime}"`, `rv:evaluatedAt "${editTime}"`), binding: correctionBinding, expected: 'invalid' },
        { name: 'changed-original-submission', source: correction.replace(`rv:originalSubmissionAt "${initialTime}"`, `rv:originalSubmissionAt "${editTime}"`), binding: correctionBinding, expected: 'invalid' },
        { name: 'wrong-revision-time', source: source.replace(`rv:revisedAt "${initialTime}"`, `rv:revisedAt "${editTime}"`), binding, expected: 'invalid' },
        { name: 'foreign-daily-period', source: source.replace('rv:observationHead', 'rv:ratingDay "2026-09-24" ; rv:observationHead'), binding, expected: 'invalid' },
      ] : []),
    ];
    for (const entry of variants) {
      const nonce = crypto.randomUUID(), receipt = `urn:experience-model:${nonce}`;
      const prefixes: string[] = [], body: string[] = [];
      for (const line of entry.source.split('\n')) {
        const prefix = /^@prefix\s+(\w+):\s+<([^>]+)>\s*\.$/.exec(line);
        if (prefix) prefixes.push(`PREFIX ${prefix[1]}: <${prefix[2]}>`); else body.push(line);
      }
      await update(`CLEAR SILENT GRAPH <${current}>; CLEAR SILENT GRAPH <${control}>`);
      await update(`${prefixes.join('\n')} INSERT DATA {
        GRAPH <${current}> { ${body.join('\n')} }
        GRAPH <${control}> { <${dataset}> <${rv}dataEpoch> "${nonce}" ; <${rv}routingEpoch> "1" ; <${rv}sequence> 0 . } }`);
      const response = await fetch(`${base}/command`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN}` },
        body: JSON.stringify({ receipt, digest: nonce, deadlineMs: 10_000,
          validations: candidate.focus.map(focus => ({ profile, sha256: profileRegistry[profile].sha256,
            shape: focus.shape.replace('realm-standing-', 'realm-experience-'), focus: [focus.focus],
            graphs: [current], binding: entry.binding })),
          update: `PREFIX rv: <${rv}>
            DELETE { GRAPH <${control}> { <${dataset}> rv:sequence 0 } }
            INSERT { GRAPH <${control}> { <${dataset}> rv:sequence 1 }
              GRAPH <${receipts}> { <${receipt}> a rv:OperationReceipt ; rv:requestDigest "${nonce}" ;
                rv:datasetId <${dataset}> ; rv:dataEpoch "${nonce}" ; rv:sequence 1 ; rv:outcome rv:Succeeded . }
              GRAPH <${outbox}> { <${receipt}:batch> a rv:OutboxBatch ; rv:dataEpoch "${nonce}" ; rv:sequence 1 ; rv:eventCount 0 . }
            } WHERE { GRAPH <${control}> { <${dataset}> rv:sequence 0 ; rv:dataEpoch "${nonce}" ; rv:routingEpoch "1" . }
              FILTER NOT EXISTS { GRAPH <${receipts}> { <${receipt}> ?p ?o } } }` }) });
      const result = await response.json() as { status: string; report?: string };
      if (result.status !== entry.expected) console.error(`${kind}/${entry.name}: ${JSON.stringify(result)}`);
      expect({ kind, case: entry.name, status: result.status }).toEqual({ kind, case: entry.name, status: entry.expected });
      const query = async (sparql: string) => {
        const response = await fetch(`${base}/query?query=${encodeURIComponent(sparql)}`,
          { headers: { accept: 'application/sparql-results+json' } });
        return response.json() as Promise<{ boolean: boolean }>;
      };
      expect((await query(`ASK { GRAPH <${receipts}> { <${receipt}> ?p ?o } }`)).boolean).toBe(entry.expected === 'committed');
      expect((await query(`ASK { GRAPH <${control}> { <${dataset}> <${rv}sequence> ${entry.expected === 'committed' ? 1 : 0} } }`)).boolean).toBe(true);
      expect((await query(`ASK { GRAPH <${outbox}> { <${receipt}:batch> ?p ?o } }`)).boolean).toBe(entry.expected === 'committed');
    }
  }
}, 60_000);

test('RATE05/MODEL17: native policy successor keeps the question head and rejects malformed revisions', async () => {
  if (!Bun.env.FUSEKI_URL || !Bun.env.MODEL_NATIVE_EQUIVALENCE) throw new Error('Run through the native model tier');
  const base = Bun.env.FUSEKI_URL.replace(/\/$/, ''), rv = 'https://rezics.com/vocab/';
  const context = 'https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000051';
  const basis = 'https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000052';
  const successor = 'https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000053';
  const current = 'urn:rezics:graph:current', revisions = 'urn:rezics:graph:revisions';
  const control = 'urn:rezics:graph:control', receipts = 'urn:rezics:graph:receipts';
  const outbox = 'urn:rezics:graph:outbox', dataset = 'urn:rezics:dataset:product';
  const profile = 'rating-aggregate-default-policy-v1';
  const selected = 'https://rezics.com/definition/rating-mean-per-rater-v1';
  const upload = async (query: string) => {
    const response = await fetch(`${base}/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' }, body: query });
    if (!response.ok) throw new Error(`model update ${response.status}: ${await response.text()}`);
  };
  const ask = async (query: string) => {
    const response = await fetch(`${base}/query?query=${encodeURIComponent(query)}`,
      { headers: { accept: 'application/sparql-results+json' } });
    return (await response.json() as { boolean: boolean }).boolean;
  };
  for (const variant of ['valid', 'missing-predecessor', 'wrong-reduction', 'stale-head'] as const) {
    const nonce = crypto.randomUUID(), receipt = `urn:rating-policy-model:${nonce}`;
    await upload(`CLEAR SILENT GRAPH <${current}>; CLEAR SILENT GRAPH <${revisions}>;
      CLEAR SILENT GRAPH <${control}>; CLEAR SILENT GRAPH <${receipts}>; CLEAR SILENT GRAPH <${outbox}>`);
    await upload(`PREFIX rv: <${rv}> INSERT DATA {
      GRAPH <${current}> { <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000050>
        a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <${context}> .
        <${context}> a rv:RatingContext, rv:ExperienceRatingContext ;
        rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000050> ;
        rv:question "Aggregate experience quality"@en ; rv:targetGrain rv:MainVersion ;
        rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
        rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ;
        rv:head <${basis}> ;
        rv:ratingPolicyHead <${basis}> ;
        rv:ratingCadence <https://rezics.com/definition/rating-experience-v1> ;
        rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> . }
      GRAPH <${revisions}> { <${basis}> a rv:RevisionAnchor ; rv:component <${context}> . }
      GRAPH <${control}> { <${dataset}> rv:dataEpoch "${nonce}" ; rv:routingEpoch "1" ; rv:sequence 0 . }
    }`);
    const attemptedHead = variant === 'stale-head' ? successor : basis;
    const revisionTriples = `<${successor}> a rv:RatingPolicyRevision, rv:RevisionAnchor ;
      rv:component <${context}> ; rv:contextRevision <${basis}> ;
      ${variant === 'missing-predecessor' ? '' : `rv:predecessor <${basis}> ;`}
      rv:ratingAggregationPolicy <${variant === 'wrong-reduction' ? 'https://rezics.com/definition/rating-unreviewed-v1' : selected}> ;
      rv:modelRevision <https://rezics.com/definition/${profile}> ;
      rv:manifest <urn:rezics:sha256:${'a'.repeat(64)}> .`;
    const update = `PREFIX rv: <${rv}>
      DELETE { GRAPH <${control}> { <${dataset}> rv:sequence 0 }
        GRAPH <${current}> { <${context}> rv:ratingPolicyHead <${attemptedHead}> } }
      INSERT { GRAPH <${control}> { <${dataset}> rv:sequence 1 }
        GRAPH <${current}> { <${context}> rv:ratingPolicyHead <${successor}> }
        GRAPH <${revisions}> { ${revisionTriples} }
        GRAPH <${receipts}> { <${receipt}> a rv:OperationReceipt ; rv:requestDigest "${nonce}" ;
          rv:outcome rv:Succeeded ; rv:datasetId <${dataset}> ; rv:dataEpoch "${nonce}" ; rv:sequence 1 . }
        GRAPH <${outbox}> { <${receipt}:batch> a rv:OutboxBatch ; rv:dataEpoch "${nonce}" ;
          rv:sequence 1 ; rv:eventCount 1 ; rv:event <${receipt}:event> .
          <${receipt}:event> a rv:RatingPolicyChangedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.policy.set" ; rv:receipt <${receipt}> . }
      } WHERE { GRAPH <${control}> { <${dataset}> rv:sequence 0 ; rv:dataEpoch "${nonce}" ; rv:routingEpoch "1" . }
        GRAPH <${current}> { <${context}> rv:ratingPolicyHead <${attemptedHead}> }
        FILTER NOT EXISTS { GRAPH <${receipts}> { <${receipt}> ?p ?o } } }`;
    const validations = [{ profile: 'realm-experience-rating-context-v1',
      sha256: profileRegistry['realm-experience-rating-context-v1'].sha256,
      shape: 'https://rezics.com/definition/realm-experience-rating-context-v1/realm-shape',
      focus: ['https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000050'], graphs: [current],
      binding: { realm: 'https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000050',
        context, question: 'Aggregate experience quality' } },
    { profile: 'realm-experience-rating-context-v1',
      sha256: profileRegistry['realm-experience-rating-context-v1'].sha256,
      shape: 'https://rezics.com/definition/realm-experience-rating-context-v1/context-shape',
      focus: [context], graphs: [current],
      binding: { realm: 'https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000050',
        context, question: 'Aggregate experience quality' } },
    ...profileRegistry[profile].shapes.map((shape, index) => ({
      profile, sha256: profileRegistry[profile].sha256, shape,
      focus: [index === 0 ? context : successor], graphs: [current, revisions],
      binding: { context, revision: successor, contextRevision: basis, predecessor: basis,
        aggregationPolicy: 'mean-per-rater' },
    }))];
    const response = await fetch(`${base}/command`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN}` },
      body: JSON.stringify({ receipt, digest: nonce, deadlineMs: 10_000, validations, update }) });
    const outcome = await response.json() as { status: string; report?: string };
    if (variant === 'valid' && outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
    expect(outcome.status).toBe(variant === 'valid' ? 'committed' : variant === 'stale-head' ? 'guard-unmatched' : 'invalid');
    expect(await ask(`PREFIX rv: <${rv}> ASK { GRAPH <${current}> {
      <${context}> rv:head <${basis}> ; rv:ratingPolicyHead <${variant === 'valid' ? successor : basis}> . } }`)).toBe(true);
    expect(await ask(`PREFIX rv: <${rv}> ASK { GRAPH <${revisions}> {
      <${successor}> a rv:RatingPolicyRevision . } }`)).toBe(variant === 'valid');
  }
}, 60_000);
