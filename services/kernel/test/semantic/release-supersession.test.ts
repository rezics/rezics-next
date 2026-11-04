import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { HttpResponse, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import { bindVndbReleaseSupersession } from '../../src/semantic/release-relation-admission.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function body(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body;
}

function subject(response: HttpResponse): Subject {
  return body(response).subject as Subject;
}

const relationProperty = 'rezics:releaseSupersedes';
const relation = (target: string): StatementInput => discoveryStatement(relationProperty, target);

async function context(name: string) {
  const result = body(
    await fixture.request('editor', 'POST', '/v1/contexts', { labels: { en: name } }, discoveryKey()),
    201,
  );
  const id = (result.context as { id: string }).id;
  await fixture.grant('acceptor', ['context:read', 'context:accept', 'context:adopt'], id);
  return id;
}

async function adoptInContext(holder: CreatedSubject, statement: StatementInput, selectedContext: string) {
  const proposal = body(
    await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${holder.id}/candidates`,
      { statement },
      discoveryKey(),
    ),
    201,
  );
  const candidate = proposal.candidate as string;
  body(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${candidate}:accept`,
      { context: selectedContext, expected_head: null },
      discoveryKey(),
    ),
  );
  const target = statement.value.type === 'value' ? statement.value.content : undefined;
  const adopted = body(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}:adopt`,
      {
        context: selectedContext,
        property: statement.property.id,
        ...(typeof target === 'string' ? { target } : {}),
        mode: 'replace',
        selection: [{ candidate, rank: statement.rank ?? 'normal' }],
        expected_head: null,
      },
      discoveryKey(),
    ),
  );
  expect(adopted.adoption).toMatchObject({ context: selectedContext, property: statement.property.id });
  return candidate;
}

test('native release supersession keeps direction, chronology, Context, source evidence and page composition', async () => {
  expect(fixture.release.definition).toEqual(bundledRelease);
  expect(fixture.release.digest).toBe(bundledDigest);
  const prior = await fixture.createSubject('wd:Q20631656', 'Superseded release');
  const alternate = await fixture.createSubject('wd:Q20631656', 'Context-specific replacement');
  const current = await fixture.createSubject('wd:Q20631656', 'Superseding release');
  const work = await fixture.createSubject('wd:Q689445', 'Represented visual novel work');
  const sourceUrl = 'https://vndb.org/r1001';
  const original = {
    ...relation(prior.id),
    references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: sourceUrl } }] }],
  };
  await fixture.adopt(current, original);
  await fixture.adopt(current, discoveryStatement('wdt:P155', prior.id));
  await fixture.adopt(prior, {
    ...discoveryStatement('schema:datePublished', { time: '+2026-00-00T00:00:00Z', precision: 9 }),
    value: { type: 'somevalue' },
  });

  const selectedA = await context('Release replacement selection A');
  const selectedB = await context('Release replacement selection B');
  await adoptInContext(current, relation(alternate.id), selectedA);
  await adoptInContext(current, relation(prior.id), selectedB);
  const candidate = bindVndbReleaseSupersession({
    row: { id: '1001', rid: '1000' },
    current: { id: current.id, type: 'wd:Q20631656', sourceCode: '1001' },
    superseded: { id: prior.id, type: 'wd:Q20631656', sourceCode: '1000' },
    context: GLOBAL_CONTEXT,
    release: bundledDigest,
    sourceRecordUrl: sourceUrl,
  });
  expect(candidate).toMatchObject({
    subject: current.id,
    property: relationProperty,
    target: prior.id,
    release: bundledDigest,
    source: {
      table: 'releases_supersedes',
      currentRelease: { role: 'superseding-release', code: '1001' },
      supersededRelease: { role: 'superseded-release', code: '1000' },
    },
  });
  expect(candidate?.statement.references[0]?.parts[0]?.value.content).toBe(sourceUrl);
  expect(
    bindVndbReleaseSupersession({
      row: { id: '1001', rid: '1000' },
      current: { id: current.id, type: 'wd:Q20631656', sourceCode: '1000' },
      superseded: { id: prior.id, type: 'wd:Q20631656', sourceCode: '1001' },
      context: GLOBAL_CONTEXT,
      release: bundledDigest,
      sourceRecordUrl: sourceUrl,
    }),
  ).toBeUndefined();

  const invalid = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${current.id}/candidates`,
    { statement: relation(work.id) },
    discoveryKey(),
  );
  expect(invalid.status).toBeGreaterThanOrEqual(400);

  await fixture.catchUp([current, prior, alternate]);
  const global = subject(await fixture.read(current));
  expect(global.statements['wdt:P155']?.map((item) => item.value.content)).toEqual([prior.id]);
  expect(global.statements[relationProperty]?.map((item) => item.value.content)).toEqual([prior.id]);
  const priorReading = body(await fixture.read(prior));
  expect(
    (priorReading.subject as { statements: Record<string, { value: { type: string } }[]> }).statements[
      'schema:datePublished'
    ]?.[0]?.value.type,
  ).toBe('somevalue');
  const forward = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${current.id}/relations?property=${encodeURIComponent(relationProperty)}&limit=20`,
    ),
  );
  expect((forward.relations as { target: string }[]).map((item) => item.target)).toEqual([prior.id]);
  const inverse = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${prior.id}/links?property=${encodeURIComponent(relationProperty)}&limit=20`,
    ),
  );
  expect((inverse.links as { subject: string }[]).map((item) => item.subject)).toContain(current.id);

  for (const [selectedContext, target] of [
    [selectedA, alternate.id],
    [selectedB, prior.id],
  ] as const) {
    const reading = subject(
      await fixture.request('acceptor', 'GET', `/v1/subjects/${current.id}?context=${selectedContext}`),
    );
    expect(reading.context).toBe(selectedContext);
    const page = body(
      await fixture.request(
        'acceptor',
        'GET',
        `/v1/subjects/${current.id}/relations?property=${encodeURIComponent(relationProperty)}&context=${selectedContext}&limit=20`,
      ),
    );
    expect((page.relations as { target: string }[]).map((item) => item.target)).toContain(target);
  }

  const candidates = body(
    await fixture.request(
      'acceptor',
      'GET',
      `/v1/subjects/${current.id}/candidates?property=${encodeURIComponent(relationProperty)}&target=${prior.id}&context=${selectedA}&limit=20`,
    ),
  );
  const inspected = (candidates.candidates as { id: string; statement?: { references: { parts: { value: { content: unknown } }[] }[] } }[])
    .find((item) => item.statement?.references[0]?.parts[0]?.value.content === sourceUrl);
  expect(inspected?.statement?.references[0]?.parts[0]?.value.content).toBe(sourceUrl);
  const revisions = body(await fixture.request('acceptor', 'GET', `/v1/subjects/${current.id}/revisions?limit=20`));
  expect((revisions.revisions as { release: string }[]).every((item) => item.release === bundledDigest)).toBe(true);
  expect(revisions.next).toBeNull();

  const composed = body(await fixture.request('anonymous', 'POST', '/v1/pages:read', { target: { subject: current.id } }));
  expect(composed.catalogue).toMatchObject({
    state: 'released',
    type: 'wd:Q20631656',
    digest: bundledDigest,
  });
  expect((composed.catalogue as { definitions: { properties: Record<string, unknown> } }).definitions.properties)
    .toHaveProperty(relationProperty);
  expect(composed.viewer).toMatchObject({ state: 'anonymous', actions: { statementPropose: 'denied' } });

  await fixture.grant('editor', ['moderation:hide'], prior.id);
  body(
    await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${prior.id}:hide`,
      { reason: 'Withhold the exact replaced release' },
      discoveryKey(),
    ),
  );
  const concealed = subject(await fixture.read(current));
  expect(JSON.stringify(concealed.statements)).not.toContain(prior.id);
  const afterHide = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${current.id}/relations?property=${encodeURIComponent(relationProperty)}&limit=20`,
    ),
  );
  expect((afterHide.relations as { target: string | null }[]).some((item) => item.target === prior.id)).toBe(false);
});
