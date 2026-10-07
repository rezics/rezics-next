import { expect, test } from 'bun:test';
import { livePlatformUses, nameClosedRefusal, seedCallExposure } from './platform-use.ts';

const id = '00000000-0000-4000-a000-000000000001';

test('seed calls resolve the longest route that has the method', () => {
  expect(seedCallExposure('GET', `/v1/themes/${id}/first-party`)).toBe('platform:executable-themes');
  expect(seedCallExposure('GET', '/v1/themes/execution-control')).toBe('platform:executable-themes');
  expect(seedCallExposure('GET', `/v1/themes/${id}`)).toBe('platform:executable-themes');
  expect(seedCallExposure('POST', '/v1/themes')).toBe('platform:executable-themes');
  expect(seedCallExposure('POST', '/v1/works')).toBe('public');
  expect(seedCallExposure('GET', `/v1/works/${id}`)).toBe('public');
  expect(seedCallExposure('GET', `/v1/works/${id}/source-support`)).toBe('platform:catalogue-import');
  expect(seedCallExposure('POST', '/v1/rights/offerings')).toBe('platform:commerce');
  expect(seedCallExposure('GET', `/v1/mod-releases/${id}`)).toBe('platform:developer-extras');
  expect(seedCallExposure('POST', '/v1/prompts/revisions')).toBe('platform:developer-extras');
  expect(seedCallExposure('POST', '/v1/hub/imports')).toBe('platform:developer-extras');
  expect(seedCallExposure('POST', '/v1/lexicon/presentations')).toBe('platform:platform-admin');
  expect(seedCallExposure('GET', '/v1/lexicon/presentations?definitions=x')).toBe('public');
  expect(seedCallExposure('POST', '/v1/also-enjoyed/generation-builds')).toBe('platform:platform-admin');
  expect(seedCallExposure('GET', `/v1/compositions/${id}`)).toBe('public');
  expect(seedCallExposure('GET', `/v1/recipes/works/${id}?servings=6`)).toBe('public');
  expect(seedCallExposure('GET', `/v1/recipes/${id}/measures`)).toBe('public');
  expect(seedCallExposure('GET', `/v1/recipes/${id}`)).toBeUndefined();
  expect(seedCallExposure('GET', '/v1/not-a-route')).toBeUndefined();
});

test('a platform_closed refusal names its group and any other refusal stays as Main sent it', () => {
  const closed = JSON.stringify({ code: 'platform_closed', title: 'This capability is closed' });
  const named = nameClosedRefusal('GET', `/v1/themes/${id}/first-party`, 403, closed);
  expect(JSON.parse(named)).toEqual({ code: 'platform_closed',
    title: 'This capability is closed (platform:executable-themes)' });
  expect(nameClosedRefusal('GET', `/v1/themes/${id}/first-party`, 403, named)).toBe(named);
  const other = JSON.stringify({ code: 'forbidden', title: 'No' });
  expect(nameClosedRefusal('GET', `/v1/themes/${id}/first-party`, 403, other)).toBe(other);
  expect(nameClosedRefusal('GET', '/v1/works', 403, closed)).toBe(closed);
  expect(nameClosedRefusal('GET', `/v1/themes/${id}/first-party`, 404, closed)).toBe(closed);
  expect(nameClosedRefusal('GET', `/v1/themes/${id}/first-party`, 403, 'not-json')).toBe('not-json');
});

test('a grant page counts a live platform use whether its rows are items or grants', () => {
  const principalId = '00000000-0000-4000-a000-0000000000aa';
  const live = { permission: 'platform:use:executable-themes', active: true, validUntil: null,
    recipient: { principalId } };
  const expired = { permission: 'platform:use:commerce', active: true, validUntil: '2020-01-01T00:00:00.000Z',
    recipient: { principalId } };
  const held = livePlatformUses({ items: [live, expired] });
  expect(held.has(`${principalId} platform:use:executable-themes`)).toBe(true);
  expect(held.has(`${principalId} platform:use:commerce`)).toBe(false);
  expect(livePlatformUses({ grants: [live] }).has(`${principalId} platform:use:executable-themes`)).toBe(true);
  expect(livePlatformUses({ items: [], grants: [live] }).size).toBe(0);
});
