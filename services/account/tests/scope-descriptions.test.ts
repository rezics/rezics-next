import { expect, test } from 'bun:test';
import { accountLocales } from '../src/account-settings.ts';
import { providerScopes } from '../src/oauth-scopes.ts';
import { describeScope, scopeDescriptions } from '../src/scope-descriptions.ts';

test('every provider scope has a sentence in each interface language', () => {
  expect(scopeDescriptions.map(item => item.scope)).toEqual([...providerScopes]);
  for (const item of scopeDescriptions) {
    expect(Object.keys(item.description).sort()).toEqual([...accountLocales].sort());
    for (const locale of accountLocales) {
      const text = item.description[locale];
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain('{n}');
    }
    expect('zh-CN' in item.description).toBe(false);
  }
  expect(describeScope('work:read').description).toMatchObject({ en: 'Read works', 'zh-Hans': '读取作品' });
  expect(describeScope('openid').description['zh-Hans']).toBe('识别你的 REZICS 账号');
  expect(describeScope('work:read').description.ja).not.toBe(describeScope('work:read').description.en);
});
