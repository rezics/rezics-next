import { describe, expect, test } from 'bun:test';
import { uiLocales } from '../../i18n/define.ts';
import { isCurrent, navigation, plannedItem } from './navigation.ts';
import { parseNavCollapsed, parseTheme, preferenceCookie, themeClass } from './preferences.ts';

describe('display preferences', () => {
  test('an unknown or missing theme follows the system, which sets no class', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    for (const value of [undefined, '', 'system', 'DARK', 'blue']) expect(parseTheme(value)).toBe('system');
    expect(themeClass('system')).toBeUndefined();
    expect(themeClass('dark')).toBe('dark');
  });

  test('only an explicit collapse collapses the side navigation', () => {
    expect(parseNavCollapsed('collapsed')).toBe(true);
    expect(parseNavCollapsed('expanded')).toBe(false);
    expect(parseNavCollapsed(undefined)).toBe(false);
  });

  test('preference cookies are site-wide, long-lived and Secure over HTTPS', () => {
    expect(preferenceCookie('rezics_theme', 'dark', false))
      .toBe('rezics_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(preferenceCookie('rezics_nav', 'collapsed', true)).toEndWith('; Secure');
  });
});

describe('navigation', () => {
  test('the phone bar holds five items with one emphasized action', () => {
    expect(navigation.filter(item => item.bottom)).toHaveLength(5);
    expect(navigation.filter(item => item.emphasized)).toHaveLength(1);
    expect(new Set(navigation.map(item => item.href)).size).toBe(navigation.length);
  });

  test('every item is labelled in every interface locale', () => {
    for (const item of navigation) {
      for (const locale of uiLocales) {
        expect(item.label[locale].trim()).not.toBe('');
        if (item.planned) expect(item.planned[locale].trim()).not.toBe('');
      }
    }
  });

  test('home is current only at the root; other items cover their subtree', () => {
    const [home, discover] = navigation;
    expect(isCurrent(home!, '/')).toBe(true);
    expect(isCurrent(home!, '/discover')).toBe(false);
    expect(isCurrent(discover!, '/discover')).toBe(true);
    expect(isCurrent(discover!, '/discovery')).toBe(false);
  });

  test('a planned route shows its coming-soon item; unknown routes stay not found', () => {
    expect(plannedItem('/shelves')?.label.en).toBe('Shelves');
    expect(plannedItem('/inbox/42')?.label.en).toBe('Inbox');
    expect(plannedItem('/nowhere')).toBeUndefined();
    expect(plannedItem('/search')).toBeUndefined();
  });
});
