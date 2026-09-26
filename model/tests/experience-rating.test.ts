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
