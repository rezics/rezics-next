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
  expect(source).toMatch(/overflow-y:\s*auto/);
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
  const toolbar = await read('../../../packages/ui/src/components/editor-touch-bar.tsx');
  const selection = await read('../../../packages/ui/src/components/editor-selection-menu.tsx');
  const blocks = await read('../../../packages/ui/src/components/editor-slash-menu.tsx');
  const css = await read('../src/styles.css');
  expect(composer).toContain('thread-opening-editor');
  expect(css).toContain('min-height: 8lh');
  expect(css).toContain('min-height: calc(8lh + 1.5rem)');
  expect(composer).toContain("toolbar: 'always'");
  expect(toolbar).toContain('labels.toolbar');
  expect(selection).toContain('labels.formatting');
  expect(blocks).toContain('labels.insertBlock');
  expect(editor).toContain('EditorTouchBar');
  expect(editor).toContain('SelectionMenu');
  expect(editor).toContain('SlashMenu');
});

test('composer defers kernel writes until send and retains existing refusal and upload handling', async () => {
  const composer = await read('../src/threads/composer.tsx');
  const postComposer = composer.slice(
    composer.indexOf('export function PostComposer'),
    composer.indexOf('export function postEditFailureText'),
  );
  expect(composer).toContain('onSubmit({ title, body: bodyRef.current');
  expect(composer).toContain('onSubmit({ body: bodyRef.current');
  expect(postComposer.match(/\bonSubmit\(/gu)).toHaveLength(1);
  expect(composer).toContain('uploadReplyImage');
  expect(composer).toContain('refusalText(failure)');
  expect(composer).toContain('uploadRefusalText');
});

test('composer stories cover every requested state at phone and desktop widths', async () => {
  const stories = await read('../src/stories/composer.stories.tsx');
  for (const state of [
    'ReplyEmpty',
    'ReplyWithText',
    'ReplyWithImage',
    'ReplyRefusal',
    'NewThreadEmpty',
    'NewThreadLong',
  ]) {
    expect(stories).toContain(`export const ${state}:`);
    expect(stories).toContain(`export const ${state}390:`);
  }
});
