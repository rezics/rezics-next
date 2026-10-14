import { expect, test } from 'bun:test';
import { closureZoneReadPath } from '../integration/outcomes/realm/closure-zone-home-setup.ts';

const closed = '/v1/realms/11111111-1111-4111-8111-111111111111';
const absent = '/v1/realms/22222222-2222-4222-8222-222222222222';
const about = encodeURIComponent('https://rezics.com/id/33333333-3333-4333-8333-333333333333');
const suffixes = [
  '/zone', `/about-thread?about=${about}`,
  ...['new-adoptions', 'recently-completed', 'recent-decisions', 'latest-chapters',
    'discussions', 'reader-quotes', 'editor-lists', 'browse'].map(module => `/modules/${module}`),
  '/modules/browse?limit=20&cursor=opaque%2Bcursor',
];

test.each(['stranger', 'member', 'owner', 'moderator', 'operator'])('%s keeps its subject on both Realm reads', name => {
  const person = { actingSubject: `https://rezics.com/id/${name}` };
  for (const suffix of suffixes) {
    for (const root of [closed, absent]) {
      const path = `${root}${suffix}`;
      const result = closureZoneReadPath(path, person);
      expect(result.startsWith(`${path}${path.includes('?') ? '&' : '?'}`)).toBe(true);
      const query = new URL(result, 'https://rezics.com').searchParams;
      expect(query.getAll('actingSubject')).toEqual([person.actingSubject]);
      query.delete('actingSubject');
      expect([...query]).toEqual([...new URL(path, 'https://rezics.com').searchParams]);
    }
  }
});

test('surviving independent resources use their signed-in reader and preserve route paths', () => {
  const person = { actingSubject: 'https://rezics.com/id/44444444-4444-4444-8444-444444444444' };
  for (const path of ['/v1/zones/id/routes?path=/', '/v1/zones/id/routes?path=/original',
    '/v1/zones/id/presentation', '/v1/works/id', '/v1/works/id/agent-credits', '/v1/content-revisions/id']) {
    const url = new URL(closureZoneReadPath(path, person), 'https://rezics.com');
    expect(url.searchParams.get('actingSubject')).toBe(person.actingSubject);
    expect(url.searchParams.get('path')).toBe(new URL(path, 'https://rezics.com').searchParams.get('path'));
  }
});

test('anonymous visitor URLs remain unchanged for delivery and absence controls', () => {
  for (const root of [closed, absent]) {
    for (const suffix of suffixes) {
      const path = `${root}${suffix}`;
      expect(closureZoneReadPath(path, { actingSubject: null })).toBe(path);
    }
  }
});
