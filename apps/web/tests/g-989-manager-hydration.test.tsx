import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../i18n/define.ts';
import { RequestsView } from '../features/manage/requests-view.tsx';
import { accessActor, accessFixtureApi, accessInitial, requestsInitial } from '../features/manage/settings-fixtures.ts';

for (const locale of uiLocales)
  test(`G-989 ${locale}: server-rendered request controls wait until their client handlers are attached`, () => {
    const html = renderToStaticMarkup(<RequestsView initial={requestsInitial} space={accessInitial.space}
      realm={accessInitial.realm} actingSubject={accessActor} locale={locale} api={accessFixtureApi()} />);
    const controls = html.match(/<button\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    expect(controls.every((control) => /\bdisabled(?:=""|(?=[\s>]))/.test(control))).toBe(true);
    expect(html).toMatch(/<input\b[^>]*\bdisabled(?:=""|(?=[\s>]))/);
    expect(html).not.toContain('data-hydrated="true"');
  });
