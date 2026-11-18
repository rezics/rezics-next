import { expect, test } from 'bun:test';
import { readBundledWebStages } from '../scripts/bundled-web-startup.ts';

test('forwards only complete startup stages across stderr chunk boundaries', () => {
  const stages: string[] = [];
  const read = readBundledWebStages((stage) => stages.push(stage));
  read(Buffer.from('source [native-web-build] build\n[native-web-'));
  read(Buffer.from('build] render ssr\n[native-web-build] render ssr extra\n'));
  read(Buffer.from('x'.repeat(32_000)));
  read(Buffer.from('[native-web-build] listen\n[native-web-build] generate-bundle client\n'));
  read(Buffer.from('[native-web-build] render-failed ssr count=6759 code=MISSING_EXPORT\n'));
  read(Buffer.from('[native-web-build] graph-failed client count=1 code=private\n'));
  read(Buffer.from('[native-web-build] unknown\n[native-web-build] render private\n[native-web-build] preview'));
  expect(stages).toEqual(['render ssr', 'generate-bundle client', 'render-failed ssr count=6759 code=MISSING_EXPORT']);
});
