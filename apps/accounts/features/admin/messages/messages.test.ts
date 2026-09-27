import { describe, expect, test } from 'bun:test';
import { i18n } from '../../../i18n/locale.ts';
import { resources } from '../../../i18n/resources.ts';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || '$nativeI18n' in value) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key));
}

describe('admin panel messages', () => {
  test('both locales have the same messages', async () => {
    const [english, chinese] = await Promise.all([resources.loaders.en.admin(), resources.loaders['zh-Hans'].admin()]);
    expect(keys(chinese).sort()).toEqual(keys(english).sort());
  });

  test('they materialize with their values in both locales', async () => {
    const [english, chinese] = await Promise.all([i18n.getTranslation('admin', ['en']), i18n.getTranslation('admin', ['zh-Hans'])]);
    expect(english.t.selected(3)).toBe('3 selected');
    expect(chinese.t.selected(3)).toBe('已选 3 位');
    expect(english.t.bulkTitles.suspend(1)).toBe('Suspend 1 user?');
    expect(chinese.t.actionTitles.suspend({ name: '李明' })).toBe('暂停 李明？');
    expect(english.t.jobResult({ succeeded: 2, skipped: 1, failed: 0 })).toBe('2 done · 1 unchanged · 0 failed');
  });
});
