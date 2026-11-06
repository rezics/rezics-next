import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  platformRegistry,
  resolveTemplate,
  validateDocumentFilters,
  type PresentationProfile,
} from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json' with { type: 'json' };

test('home TypeList selectors follow the current catalogue release', () => {
  const page = resolveTemplate(platform as PresentationProfile, { route: '/' });
  expect(page).toMatchObject({ scope: 'route', key: '/' });
  expect(validateDocumentFilters(platformRegistry, page.document, bundledRelease)).toEqual([]);
  expect(validateDocumentFilters(platformRegistry, page.document, { types: {}, properties: {} })).toEqual([
    { pointer: '/content/2/props/filter/type/in/0', code: 'invalid' },
    { pointer: '/content/3/props/filter/type/in/0', code: 'invalid' },
    { pointer: '/content/4/props/filter/type/in/0', code: 'invalid' },
    { pointer: '/content/5/props/filter/type/in/0', code: 'invalid' },
  ]);
});
