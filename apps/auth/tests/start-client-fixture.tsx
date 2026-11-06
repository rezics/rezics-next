// One dev-server document mounted through the real Start client, in a child process so the build-time stubs and
// happy-dom globals stay out of other test files. The parent test passes the document name and its location.
// The documents are verbatim dev-server responses, stored as .txt so the formatter cannot rewrite their markup.
// Recapture them with the browser navigation headers when a route's server markup changes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const app = join(import.meta.dir, '..');
// Start's Vite plugin normally supplies these virtual entries and compiles isomorphic functions to the client branch.
Bun.plugin({
  name: 'start-client-fixture',
  setup(build) {
    build.onLoad({ filter: /fake-entries\/router\.js$/ }, () => ({
      contents: `export { getRouter } from ${JSON.stringify(join(app, 'src/router.tsx'))};`,
      loader: 'js',
    }));
    build.onLoad({ filter: /fake-entries\/start\.js$/ }, () => ({
      contents: `export { startInstance } from ${JSON.stringify(join(app, 'src/start.ts'))};`,
      loader: 'js',
    }));
    build.onLoad({ filter: /start-fn-stubs\/dist\/esm\/createIsomorphicFn\.js$/ }, () => ({
      contents: `export function createIsomorphicFn() {
        let implementation;
        const build = () => implementation();
        build.server = () => build;
        build.client = (fn) => ((implementation = fn), build);
        return build;
      }`,
      loader: 'js',
    }));
    // Plain Bun resolves router-core's isServer to the server variant; the browser build resolves the client variant.
    build.onLoad({ filter: /router-core\/dist\/esm\/isServer\/server\.js$/ }, () => ({
      contents: 'export const isServer = false;\nexport const loadServerRoute = undefined;',
      loader: 'js',
    }));
    // Server-only entry: the client build removes its import, so the client fixture only needs its exported names.
    build.onLoad({ filter: /react-start\/dist\/esm\/server\.js$/ }, () => ({
      contents:
        'export function getRequest() { throw new Error("server request in the client fixture"); }\nexport function setResponseHeader() {}',
      loader: 'js',
    }));
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: 'export const env = { AUTH_SECURITY_SCOPE_CONFIGURATION: "catalogue:20" };',
      loader: 'js',
    }));
  },
});

const [name, path] = process.argv.slice(2);
const webDir = join(import.meta.dir, '../../web');
const { Window } = require(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', webDir))));
const dom = new Window({ url: `https://rezics.com${path}` });
const globals: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  NodeFilter: dom.NodeFilter,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  scrollTo: () => {},
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
const { act, createElement } = await import('react');
const { hydrateRoot } = await import('react-dom/client');
const { StartClient } = await import('@tanstack/react-start/client');

// Install the server document as the browser receives it, then run its streamed bootstrap exactly once.
const server = readFileSync(join(import.meta.dir, 'start-documents-fixture', `${name}.txt`), 'utf8');
const parsed = new dom.DOMParser().parseFromString(server, 'text/html');
for (const attribute of [...document.documentElement.attributes])
  document.documentElement.removeAttribute(attribute.name);
for (const attribute of [...parsed.documentElement.attributes])
  document.documentElement.setAttribute(attribute.name, attribute.value);
document.documentElement.innerHTML = parsed.documentElement.innerHTML;
const bootstrap = [...server.matchAll(/<script[^>]*data-tsr-stream-part[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]!)
  .find((body) => body.includes('$_TSR'));
if (!bootstrap) throw new Error(`${name} has no streamed bootstrap`);
new Function('self', 'document', bootstrap)(globalThis, {
  currentScript: { previousElementSibling: null, remove() {} },
});
(window as unknown as { $_TSR: unknown }).$_TSR = (globalThis as unknown as { $_TSR: unknown }).$_TSR;

const errors: string[] = [];
const logs: string[] = [];
console.error = (...args: unknown[]) => logs.push(args.map(String).join(' ').slice(0, 300));
await act(async () => {
  hydrateRoot(document, createElement(StartClient), {
    onRecoverableError: (error: unknown) => errors.push(String((error as Error)?.message ?? error).slice(0, 300)),
  });
});
for (let waited = 0; waited < 15_000 && !document.documentElement.hasAttribute('data-hydrated'); waited += 50)
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const result = {
  hydrated: document.documentElement.hasAttribute('data-hydrated'),
  heading: document.querySelector('h1')?.textContent ?? null,
  errors,
  logs: logs.slice(0, 5),
};
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
process.exit(0);
