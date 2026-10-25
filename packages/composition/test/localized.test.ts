import { expect, test } from 'bun:test';
import Type from 'typebox';
import { Compile } from 'typebox/schema';
import {
  compositionSchema,
  defineRegistry,
  localizedText,
  pickText,
  platformRegistry,
  validateComposition,
} from '../src/index.ts';

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${String.fromCharCode(97 + i)}`, 'x']));

test('headings, text and list titles take localized text', () => {
  const document = page(
    node('Heading', 'title', { text: { en: 'Works', ja: '作品', 'zh-Hant': '作品' }, level: 2 }),
    node('Text', 'intro', { text: 'Plain text still works' }),
    node('SubjectList', 'works', { title: { en: 'Works', de: 'Werke' }, property: 'schema:author', limit: 12 }),
  );
  expect(validateComposition(platformRegistry, document)).toEqual([]);
  expect(
    validateComposition(
      platformRegistry,
      page(
        node('Heading', 'a', { text: { en: '<script>alert(1)</script>', ja: '安全' }, level: 2 }),
        node('Heading', 'b', { text: { 'EN!': 'x' }, level: 2 }),
        node('Heading', 'c', { text: {}, level: 2 }),
        node('Text', 'd', { text: { en: 'x'.repeat(2001) } }),
        node('Heading', 'e', { text: { en: 1 }, level: 2 }),
        node('Heading', 'f', { text: seventeen, level: 2 }),
        node('Heading', 'g', { text: ['en', 'x'], level: 2 }),
        node('SubjectList', 'h', { title: { en: '<b>x</b>' }, property: 'schema:author', limit: 1 }),
      ),
    ),
  ).toEqual([
    { pointer: '/content/0/props/text/en', code: 'unsafe' },
    { pointer: '/content/1/props/text/EN!', code: 'invalid' },
    { pointer: '/content/2/props/text', code: 'invalid' },
    { pointer: '/content/3/props/text/en', code: 'invalid' },
    { pointer: '/content/4/props/text/en', code: 'invalid' },
    { pointer: '/content/5/props/text', code: 'invalid' },
    { pointer: '/content/6/props/text', code: 'invalid' },
    { pointer: '/content/7/props/title/en', code: 'unsafe' },
  ]);
});

test('a registry admits localized text and its schema carries the same rules', () => {
  const closed = { additionalProperties: false };
  const registry = defineRegistry({
    root: Type.Object({}, closed),
    components: [{ type: 'Note', props: Type.Object({ text: localizedText({ maxLength: 20 }) }, closed) }],
  });
  const validator = Compile(compositionSchema(registry) as never);
  const note = (text: unknown) => ({ root: { props: {} }, content: [{ type: 'Note', props: { id: 'n', text } }] });
  for (const text of ['Plain', { en: 'Hello', 'zh-Hant': '你好' }]) {
    expect(validateComposition(registry, note(text))).toEqual([]);
    expect(validator.Check(note(text))).toBe(true);
  }
  for (const text of ['<b>x</b>', { en: '<b>x</b>' }, { 'EN!': 'x' }, {}, seventeen, { en: 'x'.repeat(21) }, 1]) {
    expect(validateComposition(registry, note(text))).toHaveLength(1);
    expect(validator.Check(note(text))).toBe(false);
  }
});

test("pickText chooses the reader's locale, then a related one, then English, then the first", () => {
  const text = { en: 'Works', ja: '作品', 'zh-Hans': '作品集', de: 'Werke' };
  expect(pickText(text, 'ja')).toEqual({ text: '作品', lang: 'ja' });
  expect(pickText(text, 'zh-Hant')).toEqual({ text: '作品集', lang: 'zh-Hans' });
  expect(pickText({ 'zh-Hant': '甲', zh: '乙', 'zh-Hans': '丙' }, 'zh-HK')).toEqual({ text: '乙', lang: 'zh' });
  expect(pickText(text, 'de-AT')).toEqual({ text: 'Werke', lang: 'de' });
  expect(pickText(text, 'fr')).toEqual({ text: 'Works', lang: 'en' });
  expect(pickText({ ko: '작품', de: 'Werke' }, 'fr')).toEqual({ text: 'Werke', lang: 'de' });
  expect(pickText('Plain', 'ja')).toEqual({ text: 'Plain', lang: null });
});
