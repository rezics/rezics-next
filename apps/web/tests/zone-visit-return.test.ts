import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { subjectVisitReturn, withSubjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { composedZoneMembersFake } from '../src/zones/static-fakes';
import {
  parseZoneVisit,
  retainZoneCursor,
  zoneMemberHref,
  zonePageSearch,
  zoneRouteHref,
  zoneSubjectHref,
  zoneVisitHref,
  zoneVisitIdentity,
  zoneVisitReturn,
} from '../src/zones/visit';

const zoneId = composedZoneMembersFake.zone.id;
const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';

test('Zone visit return admits configured routes, subjects and opaque cursors', () => {
  expect(zoneVisitReturn(`/en/zones/${zoneId}`, 'en')).toBe(`/en/zones/${zoneId}`);
  expect(zoneVisitReturn(`/en/zones/${zoneId}/guide?cursor=next_members-2`, 'en')).toBe(
    `/en/zones/${zoneId}/guide?cursor=next_members-2`,
  );
  expect(zoneVisitReturn(`/en/zones/${zoneId}/subjects/${subjectId}`, 'en')).toBe(
    `/en/zones/${zoneId}/subjects/${subjectId}`,
  );
  expect(zoneVisitReturn(`/en/zones/${zoneId}/subjects/${subjectId}/details`, 'en')).toBe(
    `/en/zones/${zoneId}/subjects/${subjectId}/details`,
  );
  expect(zoneVisitReturn(`/zh-Hant/zones/${zoneId}`, 'en')).toBeUndefined();
  expect(zoneVisitReturn(`/en/zones/${zoneId}/subjects`, 'en')).toBeUndefined();
  expect(zoneVisitReturn(`/en/zones/${zoneId}?cursor=bad/cursor`, 'en')).toBeUndefined();
  expect(zoneVisitReturn(`https://evil.test/en/zones/${zoneId}`, 'en')).toBeUndefined();
});

test('canonical Subject readers keep a bounded same-tab Zone return', () => {
  const visit = `/en/zones/${zoneId}`;
  expect(subjectVisitReturn(visit, 'en')).toBe(visit);
  const left = withSubjectVisitReturn(`/en/subjects/${subjectId}/the-little-prince`, visit, 'en');
  expect(left).toContain(`via=${encodeURIComponent(visit)}`);
  expect(subjectVisitReturn(new URL(left, 'https://rezics.invalid').searchParams.get('via'), 'en')).toBe(visit);
  expect(withSubjectVisitReturn(`/en/zones/${zoneId}/subjects/${subjectId}`, visit, 'en')).toBe(
    `/en/zones/${zoneId}/subjects/${subjectId}`,
  );
});

test('standalone Subject return helpers preserve Zone, franchise, credit, release and game fragments', () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
        import assert from 'node:assert/strict';
        import { subjectVisitReturn, workFranchiseReturnHref, zoneVisitReturn } from './src/features/pages/subject-visit-navigation.ts';
        import { gameClassificationReturnFragment } from './src/features/catalogue/game-current-visit-descriptor.ts';
        import { releaseReturnHref } from './src/features/catalogue/release-fidelity/navigation.ts';

        const zoneId = '0192f3a0-6c1e-7b2a-9d4e-000000000040';
        const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
        const statement = '01a17a3b-0884-721b-91ef-d7ffd7bb58e7';
        const zone = '/en/zones/' + zoneId;
        assert.equal(zoneVisitReturn(zone, 'en'), zone);
        assert.equal(subjectVisitReturn(zone, 'en'), zone);

        const base = '/en/subjects/' + subjectId + '/book/relations?realm=' + zoneId + '&node=franchise&streamProperty=wdt%3AP144&streamDirection=forward&cursor=current';
        const franchise = workFranchiseReturnHref(base, base, 'en', {
          stream: 'out:wdt:P144', node: 'franchise', statement, holder: subjectId, spoiler: 0, focus: 'evidence',
        });
        assert.equal(subjectVisitReturn(franchise, 'en'), franchise);

        const credit = '/en/subjects/' + subjectId + '/book/works#person-credit?context=' + zoneId + '&definition=rezics%3Acredit';
        assert.equal(subjectVisitReturn(credit, 'en'), credit);

        const release = releaseReturnHref('Book', 'en', {
          id: subjectId, context: zoneId, digest: 'sha256:' + 'a'.repeat(64), revision: 1, focus: 'work',
        });
        assert.ok(release);
        assert.equal(subjectVisitReturn(release, 'en'), release);

        const gameSource = '/en/subjects/' + subjectId + '/video-game?realm=' + zoneId;
        const gameFragment = gameClassificationReturnFragment({
          source: gameSource, holder: subjectId, context: zoneId, realm: zoneId, type: 'vndb:game', locale: 'en',
          release: 'sha256:' + 'b'.repeat(64), reader: null, property: 'wdt:P123', statement, focus: 'keyboard',
        });
        assert.ok(gameFragment);
        assert.equal(subjectVisitReturn(gameSource + gameFragment, 'en'), gameSource + gameFragment);
        console.log('standalone-return-ok');
      `,
    ],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  expect(child.stdout.toString().trim()).toBe('standalone-return-ok');
});

test('source replacement drops another visit continuation', () => {
  expect(zonePageSearch({ cursor: 'next_members-2' })).toEqual({ cursor: 'next_members-2' });
  expect(zonePageSearch({ cursor: 'bad/cursor' })).toEqual({});
  const visit = parseZoneVisit(`/en/zones/${zoneId}?cursor=next_members-2`, 'en')!;
  expect(zoneVisitHref(visit)).toBe(`/en/zones/${zoneId}?cursor=next_members-2`);
  expect(retainZoneCursor(visit, zoneVisitIdentity(visit, '4'), '4')).toBe('next_members-2');
  expect(retainZoneCursor(visit, zoneVisitIdentity(visit, '4'), '5')).toBeUndefined();
  expect(zoneMemberHref(visit, { id: subjectId })).toBe(zoneSubjectHref('en', zoneId, subjectId));
  expect(zoneRouteHref('en', zoneId, 'guide', 'next_members-2')).toBe(
    `/en/zones/${zoneId}/guide?cursor=next_members-2`,
  );
});
