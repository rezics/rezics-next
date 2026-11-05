import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/** Base UI binds layout effects when the module first loads. A missing document makes later dialogs a no-op. */
if (typeof document === 'undefined' || !('documentElement' in document)) {
  const { Window } = createRequire(import.meta.url)(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))),
  ) as { Window: new (options: { url: string }) => { document: Document } };
  const window = new Window({ url: 'https://site.test/en' });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: window.document,
  });
}
