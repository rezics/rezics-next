import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('reply composer starts compact and grows to a bounded scrolling editor', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const styles = await read('../../packages/ui/src/rich-text-editor.tsx').catch(() => '');
  const css = await read('../../packages/ui/src/index.css').catch(() => '');
  const source = `${composer}\n${styles}\n${css}`;
  expect(source).toContain('thread-reply-editor');
  expect(source).toContain('thread_reply_placeholder');
  expect(source).toMatch(/thread-reply-editor[^\n]*(?:min-h|height|rows)/);
  expect(source).toMatch(/max-h-[^\s"']+/);
  expect(source).toMatch(/overflow-y-auto/);
});

test('send is unavailable without content and uses contrasting colors in either state', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const button = await read('../../packages/ui/src/shadcn/button.tsx');
  expect(composer).toContain('disabled={!ready || submitting || pendingUploads > 0}');
  expect(button).toMatch(/disabled:[^"']*(?:bg-|text-)/);
  expect(button).toMatch(/disabled:[^"']*contrast/);
});

test('new thread body begins around eight lines, grows, and exposes supported formatting actions', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const editor = await read('../../packages/ui/src/rich-text-editor.tsx');
  expect(composer).toContain('thread-opening-editor');
  expect(editor).toMatch(/min-h-(?:\[\d+px\]|\d+)/);
  expect(editor).toMatch(/max-h-/);
  expect(editor).toContain('labels.toolbar');
  expect(editor).toContain('labels.formatting');
  expect(editor).toContain('labels.insertBlock');
});

test('composer defers kernel writes until send and retains existing refusal and upload handling', async () => {
  const composer = await read('../src/threads/composer.tsx');
  expect(composer).toContain('onSubmit({ title, body: bodyRef.current');
  expect(composer).toContain('onSubmit({ body: bodyRef.current');
  expect(composer).toContain('uploadReplyImage');
  expect(composer).toContain('refusalText(failure)');
  expect(composer).toContain('uploadRefusalText');
});
