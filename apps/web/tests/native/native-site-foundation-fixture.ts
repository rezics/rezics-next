import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NativeWebStack } from './stack.ts';

export const nativeSiteLocales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type NativeSiteLocale = (typeof nativeSiteLocales)[number];

export const nativeSubjectLabels: Record<NativeSiteLocale, string> = {
  en: 'Foundation Orbit Book',
  'zh-Hans': '基础轨道书籍',
  'zh-Hant': '基礎軌道書籍',
  ja: '基礎軌道の本',
  ko: '기초 궤도 도서',
  de: 'Grundlagen der Bahnberechnung in der internationalen Astronomie',
  fr: 'Livre fondamental sur les orbites et les observations astronomiques',
  es: 'Libro Órbita Fundamental',
};

export const nativeNavigationNames: Record<NativeSiteLocale, string> = {
  en: 'Main navigation',
  'zh-Hans': '主要导航',
  'zh-Hant': '主要導覽',
  ja: 'メインナビゲーション',
  ko: '기본 탐색',
  de: 'Hauptnavigation',
  fr: 'Navigation principale',
  es: 'Navegación principal',
};

export type NativeSiteSubject = {
  id: string;
  labels: typeof nativeSubjectLabels;
  paths: Record<NativeSiteLocale, string>;
};

export async function createNativeSiteSubject(stack: NativeWebStack): Promise<NativeSiteSubject> {
  const active = await stack.kernel('/v1/definitions/active');
  if (active.status !== 200)
    throw new Error(`Active bundled definitions returned ${active.status}: ${await active.text()}`);

  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type: 'schema:Book', labels: nativeSubjectLabels }),
    },
    'editor',
  );
  if (response.status !== 201)
    throw new Error(`Production subject create returned ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { subject?: { id?: string } };
  const id = body.subject?.id;
  if (!id) throw new Error('Production subject create returned no subject id');

  const { subjectHref } = await import('../../src/subject/subject-href.ts');
  return {
    id,
    labels: nativeSubjectLabels,
    paths: Object.fromEntries(
      nativeSiteLocales.map((locale) => [locale, subjectHref({ id, label: nativeSubjectLabels[locale] }, locale).href]),
    ) as Record<NativeSiteLocale, string>,
  };
}

export function nativeSiteScreenshotPath(locale: NativeSiteLocale, width: number, theme: 'light' | 'dark'): string {
  return resolve(import.meta.dir, '../../../../.temp/native-site-foundation', `${locale}-${width}-${theme}.png`);
}

export async function prepareNativeSiteScreenshots(): Promise<void> {
  await mkdir(resolve(import.meta.dir, '../../../../.temp/native-site-foundation'), { recursive: true });
}
