import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('reply composer starts compact and grows to a bounded scrolling editor', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const styles = await read('../../../packages/ui/src/components/rich-text-editor.tsx');
  const css = await read('../src/styles.css');
  const source = `${composer}\n${styles}\n${css}`;
  expect(source).toContain('thread-reply-editor');
  expect(source).toContain('thread_reply_placeholder');
  expect(source).toContain('min-height: 1lh');
  expect(source).toContain('min-height: calc(1lh + 1.5rem)');
  expect(source).toContain('max-height: 100dvh');
  expect(source).toMatch(/overflow-y-auto/);
});

test('send is unavailable without content and uses contrasting colors in either state', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const button = await read('../../../packages/ui/src/shadcn/button.tsx');
  expect(composer).toContain('disabled={!ready || submitting || pendingUploads > 0}');
  expect(button).toContain('bg-primary text-primary-foreground');
  expect(composer).toContain('disabled:bg-primary disabled:text-primary-foreground disabled:opacity-100');
});

test('new thread body begins around eight lines, grows, and exposes supported formatting actions', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const editor = await read('../../../packages/ui/src/components/rich-text-editor.tsx');
  const css = await read('../src/styles.css');
  expect(composer).toContain('thread-opening-editor');
  expect(css).toContain('min-height: 8lh');
  expect(css).toContain('min-height: calc(8lh + 1.5rem)');
  expect(composer).toContain("toolbar: 'always'");
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
