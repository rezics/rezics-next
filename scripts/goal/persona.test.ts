import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IndexedOperation } from '../api/operation-index.ts';
import { formatProbeAnswer, parseProbeCalls, probeRecord, probeRecordPath, redactProbe, resolveProbeCall,
  type ProbeAnswer, type ProbeCall, type ProbeResult } from './persona.ts';

function operation(method: string, path: string, operationId: string): IndexedOperation {
  return { method, path, operationId, exposure: 'public', bearer: 'no', idempotencyKey: false,
    rateLimitFamily: 'read', routeFile: 'services/main/src/routes/zones.ts', handlerLine: 1, testFiles: [] };
}
const operations = [operation('GET', '/v1/zones/{id}', 'getZone'),
  operation('GET', '/v1/realms/{realm}', 'getRealm'),
  operation('GET', '/v1/spaces/{space}', 'getSpace'),
  operation('POST', '/v1/spaces', 'postSpace')];
const id = '12345678-1234-1234-1234-123456789012';
const fixtures = { realm: `https://rezics.com/id/${id}`, space: `https://rezics.com/id/${id}`, zone: `https://rezics.com/id/${id}` };
const call: ProbeCall = { persona: 'owner', operationId: 'postSpace', method: 'POST', path: '/v1/spaces' };
const answer: ProbeAnswer = { ...call, status: 201, answer: { id: fixtures.zone }, headers: {}, elapsedSeconds: 1 };

describe('persona probe validation', () => {
  test('parses calls in order, normalizes methods, and preserves arbitrary JSON bodies', () => {
    const calls = parseProbeCalls(['owner post /v1/spaces {"name":"a b","nested":[null,true,2]}',
      'stranger GET /v1/zones/{1.id}?view=public'], operations);
    expect(calls).toEqual([{ ...call, body: { name: 'a b', nested: [null, true, 2] } },
      { persona: 'stranger', method: 'GET', path: '/v1/zones/{1.id}?view=public', operationId: 'getZone' }]);
    expect(parseProbeCalls(['visitor GET /v1/zones/concrete'], operations)[0]?.operationId).toBe('getZone');
  });

  test.each(['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'])('accepts persona %s', persona => {
    expect(parseProbeCalls([`${persona} GET /v1/zones/{zone}`], operations)[0]?.persona).toBe(persona);
  });

  test('refuses unknown personas without echoing their input', () => {
    expect(() => parseProbeCalls(['secret-person GET /v1/zones/{zone}'], operations)).toThrow('Unknown persona');
  });
  test('refuses broken JSON without echoing its input', () => {
    expect(() => parseProbeCalls(['owner POST /v1/spaces {"unclosed":'], operations)).toThrow('Broken JSON');
  });
  test.each(['visitor DELETE /v1/zones/{zone}', 'visitor GET /v1/zones/{zone}/missing',
    'visitor GET /v1/no-such-route'])('refuses absent operations with nearest IDs: %s', input => {
    expect(() => parseProbeCalls([input], operations)).toThrow(/Nearest operationIds:.*getZone/);
  });
  test.each(['visitor GET https://example.test/v1/zones/id', 'visitor GET //example.test/v1/zones/id',
    'visitor GET /v1/zones/%2e%2e', 'visitor GET /v1/zones/%2foutside', 'visitor GET /v1/zones/id#fragment'])('refuses unsafe paths: %s', input => {
    expect(() => parseProbeCalls([input], operations)).toThrow();
  });
  test('refuses unknown, malformed and forward placeholders before setup', () => {
    for (const path of ['/v1/zones/{nope}', '/v1/zones/{1.id}', '/v1/zones/{0.id}', '/v1/zones/{1.}'])
      expect(() => parseProbeCalls([`visitor GET ${path}`], operations)).toThrow();
    expect(() => parseProbeCalls(['owner POST /v1/spaces {"id":"{1.id}"}'], operations)).toThrow('earlier call');
  });
  test('credentials supplied in request bodies or query strings are refused before writing the transport file', () => {
    for (const input of ['owner POST /v1/spaces {"cookie":"secret"}',
      'owner POST /v1/spaces {"nested":{"authorization":"Bearer secret"}}',
      'visitor GET /v1/zones/{zone}?access_token=secret'])
      expect(() => parseProbeCalls([input], operations)).toThrow('Credentials belong');
  });
});

describe('persona placeholders', () => {
  test('fixture references use route IDs in paths and full IRIs in bodies and query parameters', () => {
    for (const name of ['realm', 'space', 'zone'] as const) {
      const resolved = resolveProbeCall({ ...call, path: `/v1/zones/{${name}}?resource={${name}}`,
        body: { resource: `{${name}}`, nested: [`prefix {${name}}`] } }, fixtures, []);
      expect(resolved.path).toBe(`/v1/zones/${id}?resource=${encodeURIComponent(fixtures[name])}`);
      expect(resolved.body).toEqual({ resource: fixtures[name], nested: [`prefix ${fixtures[name]}`] });
    }
  });
  test('prior answer dotted paths preserve JSON types and support arrays', () => {
    const prior = { ...answer, answer: { created: { ids: [fixtures.zone] }, revision: 2, active: false, optional: null } };
    const resolved = resolveProbeCall({ ...call, path: '/v1/zones/{1.created.ids.0}',
      body: { revision: '{1.revision}', active: '{1.active}', optional: '{1.optional}',
        object: '{1.created}', description: 'Revision {1.revision}' } }, fixtures, [prior]);
    expect(resolved.path).toBe(`/v1/zones/${id}`);
    expect(resolved.body).toEqual({ revision: 2, active: false, optional: null,
      object: { ids: [fixtures.zone] }, description: 'Revision 2' });
  });
  test('does not mutate the template or previous answers', () => {
    const template = { ...call, body: ['{1.id}'] };
    resolveProbeCall(template, fixtures, [answer]);
    expect(template.body).toEqual(['{1.id}']);
    expect(answer.answer).toEqual({ id: fixtures.zone });
  });
  test('refuses missing and inherited fields and nonscalar path values', () => {
    for (const field of ['missing', 'constructor', '__proto__'])
      expect(() => resolveProbeCall({ ...call, path: `/v1/zones/{1.${field}}` }, fixtures, [answer])).toThrow('missing');
    expect(() => resolveProbeCall({ ...call, path: '/v1/zones/{1.id}' }, fixtures,
      [{ ...answer, answer: { id: {} } }])).toThrow('scalar');
  });
});

describe('persona output and recordings', () => {
  test('bounds the JSON answer to sixty lines and full prints every line', () => {
    const large = { ...answer, answer: Array.from({ length: 100 }, (_, n) => n) };
    const bounded = formatProbeAnswer(large).split('\n');
    expect(bounded).toHaveLength(61);
    expect(bounded.at(-1)).toContain('--full');
    expect(formatProbeAnswer(large, true).split('\n')).toHaveLength(103);
    expect(formatProbeAnswer({ ...answer, answer: [1] })).not.toContain('truncated');
  });
  test('prints the caller, status, elapsed time and only the four answer headers', () => {
    const printed = formatProbeAnswer({ ...answer, headers: { location: '/created', 'retry-after': '2',
      etag: '"head"', 'cache-control': 'no-store', 'set-cookie': 'secret-cookie' } });
    expect(printed).toContain('owner POST /v1/spaces → 201 (1.000s)');
    for (const header of ['location:', 'retry-after:', 'etag:', 'cache-control:']) expect(printed).toContain(header);
    expect(printed).not.toContain('secret-cookie');
  });
  test('records only calls and application answers, stripping nested credentials from both sides', () => {
    const result: ProbeResult = { visibility: 'private', setupSeconds: 9, calls: [{ ...answer,
      body: { name: 'story', authorization: 'Bearer secret-bearer', cookie: 'secret-cookie',
        nested: { 'x-session-key': 'secret-session' } },
      headers: { 'set-cookie': 'response-cookie' },
      answer: { id: 'resource', access_token: 'response-bearer', sessionKey: 'response-session',
        nested: [{ cookie: 'nested-cookie', title: 'story' }], message: 'Bearer echoed-token' } }] };
    const recorded = JSON.stringify(probeRecord(result));
    for (const secret of ['secret-bearer', 'secret-cookie', 'secret-session', 'response-cookie',
      'response-bearer', 'response-session', 'nested-cookie', 'echoed-token', 'elapsedSeconds', 'setupSeconds', 'headers'])
      expect(recorded).not.toContain(secret);
    expect(JSON.parse(recorded)).toEqual({ visibility: 'private', calls: [{ ...call, status: 201,
      body: { name: 'story', nested: {} }, answer: { id: 'resource', nested: [{ title: 'story' }], message: '[redacted]' } }] });
    expect(probeRecord({ ...result, setupSeconds: 100, calls: result.calls.map(item => ({ ...item, elapsedSeconds: 100 })) }))
      .toEqual(probeRecord(result));
  });
  test('redacts credentials in textual answers and redirect query strings', () => {
    expect(redactProbe('Cookie: session=secret')).toBe('[redacted]');
    expect(redactProbe('/return?access_token=secret&next=/')).toBe('/return?redacted&next=/');
    expect(formatProbeAnswer({ ...answer, answer: 'Bearer token', headers: { location: '/?session_key=secret' } }))
      .not.toMatch(/\btoken\b|\bsecret\b/);
  });
  test('refuses records outside the repository, including symlink escapes', () => {
    const parent = resolve('.temp/persona-unit');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'repo-'));
    const outside = mkdtempSync(join(parent, 'outside-'));
    try {
      expect(probeRecordPath(root, 'stories/record.json')).toBe(join(root, 'stories/record.json'));
      expect(() => probeRecordPath(root, '../record.json')).toThrow('inside the repository');
      expect(() => probeRecordPath(root, '/tmp/persona-record.json')).toThrow('inside the repository');
      symlinkSync(outside, join(root, 'escape'));
      expect(() => probeRecordPath(root, 'escape/record.json')).toThrow('inside the repository');
      symlinkSync(join(outside, 'absent.json'), join(root, 'dangling.json'));
      expect(() => probeRecordPath(root, 'dangling.json')).toThrow('inside the repository');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
