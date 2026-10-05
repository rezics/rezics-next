import { expect, test } from 'bun:test';
import { readContentRatings, resolveContentRatings } from './content-rating.ts';

const target = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const response = (items: unknown[]) => Response.json({ items });

test('suitability viewing evidence can recover the text gate without trusting server eligibility or private Account fields', async () => {
  const result = await readContentRatings([target(1)], target(9), (async (_url, _init) => Response.json({
    viewer: { signedIn: true, age: 'under-15', country: 'US', birthDate: '2020-01-01',
      optIns: { general: true, r15: false, sexual: false, grotesque: false } },
    items: [{ target: { resource: target(1) }, assessment: { status: 'assessed', labels: ['r18'] }, eligible: true }],
  })) as typeof fetch);
  expect(result.viewer).toEqual({ ready: true, signedIn: true, age: 'under-15', nsfwDisplay: 'mask',
    optIns: { general: true, r15: false, sexual: false, grotesque: false } });
  expect(result.ratings[target(1)]).toEqual({ status: 'assessed', labels: ['r18'] });
});

test('incomplete viewing evidence never invents readiness or age eligibility', async () => {
  for (const viewer of [undefined, { signedIn: true, age: 'adult', optIns: {} },
    { signedIn: true, age: 'adult', optIns: { general: true, r15: true, sexual: 'yes', grotesque: true } }]) {
    const result = await readContentRatings([target(1)], null, (async (_url, _init) => Response.json({ viewer,
      items: [{ target: { resource: target(1) }, assessment: { status: 'unassessed' } }],
    })) as typeof fetch);
    expect(result.viewer).toBeNull();
  }
});

test('body ratings resolve by actual target and do not trust server eligibility or follow references', async () => {
  const calls: { path: string; body: unknown; credentials?: RequestCredentials }[] = [];
  const ratings = await resolveContentRatings([target(1), target(2)], target(9), (async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)), credentials: init?.credentials });
    return response([
      { target: { resource: target(2), work: target(99) }, assessment: { status: 'assessed', labels: ['r18g'] }, eligible: true },
      { target: { resource: target(1) }, assessment: { status: 'unassessed' }, eligible: false },
    ]);
  }) as typeof fetch);
  expect(calls).toEqual([{ path: '/api/main/v1/suitability/reads',
    body: { targets: [target(1), target(2)], actingSubject: target(9) }, credentials: 'same-origin' }]);
  expect(ratings).toEqual({ [target(1)]: { status: 'unassessed' },
    [target(2)]: { status: 'assessed', labels: ['r18g'] } });
});

test('a reader without an eligible session identity resolves public ratings without the bearer cookie', async () => {
  const ratings = await resolveContentRatings([target(1)], null, (async (_url, init) => {
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ targets: [target(1)] });
    return response([{ target: { resource: target(1) }, assessment: { status: 'unassessed' } }]);
  }) as typeof fetch);
  expect(ratings).toEqual({ [target(1)]: { status: 'unassessed' } });
});

test('missing or malformed assessment remains a failed lookup rather than general', async () => {
  const ratings = await resolveContentRatings([target(1), target(2)], null,
    (async (_url, _init) => response([{ target: { resource: target(1) }, assessment: { status: 'assessed', labels: ['r15', 'r18'] } }])) as typeof fetch);
  expect(ratings).toEqual({ [target(1)]: null, [target(2)]: null });
  await expect(resolveContentRatings([target(1)], null,
    (async (_url, _init) => response([{ target: { resource: target(2) }, assessment: { status: 'unassessed' } }])) as typeof fetch))
    .rejects.toThrow('Unexpected content rating target');
  let requested = false;
  await expect(resolveContentRatings(Array.from({ length: 65 }, (_, i) => target(i)), null,
    (async (_url, _init) => { requested = true; return response([]); }) as typeof fetch)).rejects.toThrow('batch is invalid');
  expect(requested).toBe(false);
});
