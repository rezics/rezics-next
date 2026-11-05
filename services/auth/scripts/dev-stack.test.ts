import { expect, test } from 'bun:test';
import { developmentMediaBindings, origins } from './dev-stack.ts';

test('only explicit local storage receives a stable private native object binding', () => {
  const keys = { secret: 'development-media-binding-test-secret' };
  expect(developmentMediaBindings({}, keys)).toEqual({});
  const binding = developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys);
  expect(binding.LOCAL_MEDIA_ORIGIN).toBe(origins.native);
  expect(binding.LOCAL_MEDIA_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys)).toEqual(
    binding,
  );
  expect(
    developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, { secret: 'rotated' })
      .LOCAL_MEDIA_TOKEN,
  ).not.toBe(binding.LOCAL_MEDIA_TOKEN);
});
