import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { realmStandingRatingObservationFixture } from './fixtures/native/realm-standing-rating-observation.ts';
import { realmStandingRatingContextFixture } from './fixtures/native/realm-standing-rating-context.ts';

test('RATE03/MODEL17: daily shapes and native bindings reject missing or mismatched calendar fields', async () => {
  if (!Bun.env.FUSEKI_URL || !Bun.env.MODEL_NATIVE_EQUIVALENCE) throw new Error('Run through the native model tier');
  const base = Bun.env.FUSEKI_URL.replace(/\/$/, '');
  const rv = 'https://rezics.com/vocab/';
  const current = 'urn:rezics:graph:current', control = 'urn:rezics:graph:control';
  const receipts = 'urn:rezics:graph:receipts', outbox = 'urn:rezics:graph:outbox';
  const dataset = 'urn:rezics:dataset:product';
  const timezone = 'rv:ratingTimeZone "America/New_York" ; rv:ratingCalendar <https://rezics.com/definition/rating-iso-calendar-v1> ;';
  const period = `${timezone} rv:ratingDay "2026-03-08" ; rv:periodStart "2026-03-08T05:00:00Z"^^xsd:dateTime ; rv:periodEnd "2026-03-09T04:00:00Z"^^xsd:dateTime ;`;
  const update = async (sparql: string) => {
    const response = await fetch(`${base}/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' }, body: sparql });
    if (!response.ok) throw new Error(`model fixture ${response.status}: ${await response.text()}`);
  };
  const observation = realmStandingRatingObservationFixture.cases['valid-create'];
  const context = Object.values(realmStandingRatingContextFixture.cases).find(candidate => candidate.expected)!;
  for (const [kind, candidate] of [['context', context], ['observation', observation]] as const) {
    const profile = `realm-daily-rating-${kind}-v1` as const;
    const binding: Record<string, string> = { ...candidate.args, timeZone: 'America/New_York',
      ...(kind === 'observation' ? { day: '2026-03-08',
        periodStart: '2026-03-08T05:00:00.000Z', periodEnd: '2026-03-09T04:00:00.000Z' } : {}) };
    const source = candidate.turtle.replaceAll('rating-standing-v1', 'rating-daily-v1')
      .replaceAll('a rv:RatingContext ;', `a rv:RatingContext, rv:DailyRatingContext ; ${timezone}`)
      .replaceAll('a rv:RatingObservation ;', `a rv:RatingObservation, rv:DailyRatingObservation ; ${period}`)
      .replaceAll('a rv:RatingObservationRevision ;', `a rv:RatingObservationRevision, rv:DailyRatingObservationRevision ; ${period}`)
      .replaceAll('2026-09-24T03:00:00Z', '2026-03-08T06:30:00Z');
    const variants = [
      { name: 'valid', source, binding, expected: 'committed' },
      { name: 'wrong-timezone-binding', source, binding: { ...binding, timeZone: 'UTC' }, expected: 'invalid' },
      { name: 'missing-timezone', source: source.replaceAll('rv:ratingTimeZone "America/New_York" ;', ''), binding, expected: 'invalid' },
      ...(kind === 'observation' ? [
        { name: 'missing-day', source: source.replaceAll('rv:ratingDay "2026-03-08" ;', ''), binding, expected: 'invalid' },
        { name: 'wrong-day-binding', source, binding: { ...binding, day: '2026-03-09' }, expected: 'invalid' },
        { name: 'outside-period', source: source.replaceAll('2026-03-08T06:30:00Z', '2026-03-09T04:00:00Z'), binding, expected: 'invalid' },
        { name: 'invented-predecessor', source, binding: { ...binding, predecessor: 'urn:unknown:revision' }, expected: 'invalid' },
      ] : []),
    ];
    for (const entry of variants) {
      const nonce = crypto.randomUUID(), receipt = `urn:daily-model:${nonce}`;
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
            shape: focus.shape.replace('realm-standing-', 'realm-daily-'), focus: [focus.focus],
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
      const query = await fetch(`${base}/query?query=${encodeURIComponent(`ASK { GRAPH <${receipts}> { <${receipt}> ?p ?o } }`)}`,
        { headers: { accept: 'application/sparql-results+json' } });
      expect((await query.json() as { boolean: boolean }).boolean).toBe(entry.expected === 'committed');
    }
  }
}, 60_000);
