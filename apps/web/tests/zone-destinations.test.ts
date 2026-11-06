import { expect, test } from 'bun:test';
import {
  isZoneSubjectId,
  zonePageSearch,
  zoneReturnHref,
  zoneRouteHref,
  zoneSubjectHref,
} from '../src/zones/destinations';

const zone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

test('Zone reader destinations keep the localized route, list continuation and exact subject', () => {
  expect(zoneRouteHref('en', zone)).toBe(`/en/zones/${zone}`);
  expect(zoneRouteHref('zh-Hant', zone, 'guide', 'cursor-1', 'books')).toBe(
    `/zh-Hant/zones/${zone}/guide?list=books&cursor=cursor-1`,
  );
  expect(zoneSubjectHref('en', zone, subject)).toBe(`/en/zones/${zone}/subjects/${subject}`);
  expect(zoneSubjectHref('en', zone, subject, 'details')).toBe(`/en/zones/${zone}/subjects/${subject}/details`);
  expect(zoneReturnHref('ja', zone, 'guide')).toBe(`/ja/zones/${zone}/guide`);
  expect(isZoneSubjectId(subject)).toBe(true);
  expect(isZoneSubjectId('not-a-subject')).toBe(false);
  expect(zonePageSearch('?cursor=abc&list=books')).toEqual({ cursor: 'abc', list: 'books' });
  expect(zonePageSearch('cursor=not valid')).toEqual({});
});

test('a TypeList continuation keeps the localized Zone route and list identity', () => {
  expect(zoneRouteHref('en', zone, '', 'opaque-native-cursor', 'books')).toBe(
    `/en/zones/${zone}?list=books&cursor=opaque-native-cursor`,
  );
  expect(zoneSubjectHref('zh-Hans', zone, subject, 'overview')).toBe(`/zh-Hans/zones/${zone}/subjects/${subject}`);
});
