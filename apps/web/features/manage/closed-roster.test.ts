import { expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import closure from '../../../../tests/qa/fixtures/outcomes/realm/closure-roster.json';
import { browserMainApi } from '../api/browser.ts';
import { readMembers } from './read.ts';
import { mapRealmMembers, readRealmMembersPage } from './realm-team-recorded-page.ts';

// The management roster requests are contract-derived; the unchanged closure record supplies the concealed problem.
const record = closure as AnswerRecord;
for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: closed management roster keeps the absent problem, with no identities or continuation`, async () => {
    const sample = record.personas[persona].find(item => item.label === 'members-private-header')!;
    const url = new URL(sample.path, 'https://contract.invalid');
    const realm = url.pathname.split('/')[3]!;
    const actingSubject = url.searchParams.get('actingSubject') ?? 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
    const requests: string[] = [];
    const main = browserMainApi('https://contract.invalid', { fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request.url);
      return Response.json(sample.answer, { status: sample.status });
    }) as typeof fetch });
    const loaded = await readRealmMembersPage({ main, anonymous: main }, { realm, actingSubject });
    const mapped = mapRealmMembers(loaded.page, loaded.roles, loaded.invitations, null);
    expect(mapped).toEqual({ kind: 'refusal', failure: 'missing', problem: {
      status: 404, title: 'Realm is unavailable', code: 'realm_unavailable',
    } });
    expect(loaded.agents).toEqual({});
    expect(requests).toHaveLength(3);
    expect(requests.some(path => path.includes('/v1/agents/'))).toBe(false);
    const retained = await readMembers(main, realm, { actingSubject, after: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' });
    expect(retained).toEqual(loaded.page);
    expect(requests.at(-1)).toContain('after=');
  });
}
