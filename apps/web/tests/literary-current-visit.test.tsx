import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { LiteraryProfileEntry } from '../src/features/catalogue/literary-profile-entry';
import { LiteraryCurrentVisitAdmission } from '../src/features/catalogue/literary-current-visit-view';
import { parseLiteraryCurrentVisit } from '../src/features/catalogue/literary-current-visit';
import { candidateContext } from '../src/subject/candidates';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
const context = '0192f3a0-6c1e-7b2a-9d4e-000000000943';

test('public literary entry refuses a Realm editor before mount and offers a fresh independent Global visit', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/' + id + '/book' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let mounts = 0;
  function Editor() {
    mounts++;
    return <p>Current Global editor</p>;
  }
  const source = `/en/subjects/${id}/book?realm=${realm}&context=${context}#literary-reader`;
  try {
    await act(async () =>
      root.render(
        <LiteraryProfileEntry
          id={id}
          type="schema:Book"
          label="Book"
          locale="en"
          realm={realm}
          context={context}
          source={source}
        />,
      ),
    );
    const href = host.querySelector('a')!.getAttribute('href')!;
    const input = parseLiteraryCurrentVisit(new URL(href, 'https://site.test').search, id, 'en');
    expect(input).toEqual({ kind: 'visit', visit: { context, realm, type: 'schema:Book', source } });
    const globalHref = `/en/subjects/${id}/_/literary`;
    await act(async () =>
      root.render(
        <LiteraryCurrentVisitAdmission input={input} locale="en" globalHref={globalHref}>
          <Editor />
        </LiteraryCurrentVisitAdmission>,
      ),
    );
    expect(mounts).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Global');
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([source, globalHref]);
    const fresh = parseLiteraryCurrentVisit(new URL(globalHref, 'https://site.test').search, id, 'en');
    expect(fresh).toEqual({ kind: 'direct' });
    await act(async () =>
      root.render(
        <LiteraryCurrentVisitAdmission input={fresh} locale="en" globalHref={globalHref}>
          <Editor />
        </LiteraryCurrentVisitAdmission>,
      ),
    );
    expect(mounts).toBe(1);
    expect(host.textContent).toContain('Current Global editor');
    for (const search of [
      '?context=' + context,
      '?unknown=1',
      '?source=' + 'é'.repeat(1100),
      new URL(href, 'https://site.test').search + '&realm=' + realm,
      new URL(href, 'https://site.test').search.replace(context, candidateContext),
    ]) {
      const invalid = parseLiteraryCurrentVisit(search, id, 'en');
      expect(invalid.kind).toBe('invalid');
      await act(async () =>
        root.render(
          <LiteraryCurrentVisitAdmission input={invalid} locale="en" globalHref={globalHref}>
            <Editor />
          </LiteraryCurrentVisitAdmission>,
        ),
      );
      expect(mounts).toBe(1);
    }
    await act(async () => root.render(<LiteraryProfileEntry id={id} type="bf:Instance" locale="en" />));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
