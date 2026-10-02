import { Extension, Mark, mergeAttributes, Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import UniqueID from '@tiptap/extension-unique-id';
import { CharacterCount } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { safeDocumentUrl } from './document-url.tsx';

const blockTypes = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'media', 'extensionBlock'];

const ContentLanguage = Extension.create({
  name: 'contentLanguage',
  addGlobalAttributes() {
    return [{ types: blockTypes, attributes: {
      lang: { default: null, parseHTML: element => element.getAttribute('lang') },
      dir: { default: null, parseHTML: element => element.getAttribute('dir') },
    } }];
  },
});

const Language = Mark.create({
  name: 'language',
  addAttributes() { return { lang: { default: null }, dir: { default: null } }; },
  parseHTML() { return [{ tag: 'span[lang]' }, { tag: 'span[dir]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
});

const Spoiler = Mark.create({
  name: 'spoiler',
  parseHTML() { return [{ tag: 'span[data-spoiler]' }]; },
  renderHTML() { return ['span', { 'data-spoiler': 'true', class: 'document-spoiler-authored' }, 0]; },
});

const DocumentTextStyle = TextStyle.extend({
  addAttributes() {
    return {
      color: { default: null, parseHTML: element => element.style.color || null, renderHTML: attrs => attrs.color ? { style: `color: ${attrs.color}` } : {} },
      backgroundColor: { default: null, parseHTML: element => element.style.backgroundColor || null, renderHTML: attrs => attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {} },
    };
  },
});

const TextEmphasis = Mark.create({
  name: 'textEmphasis',
  addAttributes() {
    return {
      shape: { default: 'dot' }, fill: { default: 'filled' }, color: { default: null }, position: { default: 'over' },
    };
  },
  parseHTML() { return [{ tag: 'span[data-text-emphasis]', getAttrs: element => {
    const style = element.style.textEmphasisStyle;
    return { shape: element.dataset.textEmphasis, fill: style.includes('open') ? 'open' : 'filled', color: element.style.textEmphasisColor || null, position: element.style.textEmphasisPosition.includes('under') ? 'under' : 'over' };
  } }]; },
  renderHTML({ mark }) {
    const { shape, fill, color, position } = mark.attrs;
    return ['span', { 'data-text-emphasis': shape, style: `text-emphasis-style: ${fill} ${shape}; text-emphasis-position: ${position} right;${color ? ` text-emphasis-color: ${color};` : ''}` }, 0];
  },
});

// A ruby is an inline node so annotation belongs to the base text across editing and export.
const Ruby = Node.create({
  name: 'ruby', inline: true, group: 'inline', content: 'text*', marks: '_', isolating: true,
  addAttributes() {
    return {
      rt: { default: '', rendered: false },
      position: { default: 'over', rendered: false },
      lang: { default: null, parseHTML: element => element.getAttribute('lang') },
    };
  },
  parseHTML() { return [{ tag: 'ruby', contentElement: 'span[data-ruby-base]', getAttrs: element => ({ rt: element.querySelector('rt')?.textContent ?? '', position: element.style.rubyPosition || 'over' }) }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['ruby', mergeAttributes(HTMLAttributes, { style: `ruby-position: ${node.attrs.position}` }), ['span', { 'data-ruby-base': '' }, 0], ['rp', {}, '('], ['rt', {}, node.attrs.rt], ['rp', {}, ')']];
  },
});

const SafeImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const src = safeDocumentUrl(HTMLAttributes.src, true);
    if (!src) return ['span', { 'data-image-unavailable': '' }, String(HTMLAttributes.alt ?? '')];
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src, referrerpolicy: 'no-referrer' })];
  },
});

const Media = Node.create({
  name: 'media', group: 'block', atom: true, draggable: true,
  addAttributes() { return { src: { default: '' }, kind: { default: 'file' }, caption: { default: '' } }; },
  parseHTML() { return [{ tag: 'figure[data-media]', getAttrs: element => ({
    src: element.querySelector('a')?.getAttribute('href') ?? element.querySelector('audio,video')?.getAttribute('src') ?? '',
    kind: element.dataset.media, caption: element.querySelector('figcaption')?.textContent ?? null,
  }) }]; },
  renderHTML({ node, HTMLAttributes }) {
    const src = safeDocumentUrl(node.attrs.src, true);
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-media': node.attrs.kind, contenteditable: 'false' }),
      src ? ['a', { href: src, rel: 'noopener noreferrer', tabindex: '-1' }, node.attrs.caption ?? src] : ['span', {}, node.attrs.caption ?? ''],
      ['figcaption', {}, node.attrs.caption ?? '']];
  },
});

function embeddedComponent(inline: boolean, label: string) {
  return Node.create({
    name: inline ? 'extensionInline' : 'extensionBlock', group: inline ? 'inline' : 'block',
    inline, atom: true, draggable: !inline,
    addAttributes() { return {
      definition: { default: '', rendered: false }, version: { default: '1', rendered: false },
      payload: { default: {}, rendered: false }, fallback: { default: null, rendered: false },
    }; },
    parseHTML() { return [{ tag: `${inline ? 'span' : 'div'}[data-rezics-component]`, getAttrs: element => {
      try { return JSON.parse(element.getAttribute('data-rezics-component') ?? '{}'); }
      catch { return false; }
    } }]; },
    renderHTML({ node, HTMLAttributes }) {
      return [inline ? 'span' : 'div', mergeAttributes(HTMLAttributes, {
        'data-rezics-component': JSON.stringify({ definition: node.attrs.definition, version: node.attrs.version, payload: node.attrs.payload, fallback: node.attrs.fallback }),
        class: 'document-component', contenteditable: 'false',
      }), node.attrs.fallback ?? label];
    },
  });
}

export function documentExtensions({ placeholder = '', unknownComponentLabel, maxLength, blocks = true }: { placeholder?: string; unknownComponentLabel: string; maxLength?: number; blocks?: boolean }) {
  return [
    StarterKit.configure({
      trailingNode: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', isAllowedUri: url => Boolean(safeDocumentUrl(url)), HTMLAttributes: { rel: 'noopener noreferrer', target: null } },
    }),
    ContentLanguage, Language, DocumentTextStyle, TextEmphasis, Ruby, Spoiler,
    ...(blocks ? [TableKit.configure({ table: { resizable: false } })] : []),
    TaskList, TaskItem.configure({ nested: true }),
    ...(blocks ? [SafeImage.configure({ allowBase64: false }), Media,
      embeddedComponent(false, unknownComponentLabel), embeddedComponent(true, unknownComponentLabel)] : []),
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    Placeholder.configure({ placeholder }),
    CharacterCount.configure({ limit: maxLength, textCounter: text => Array.from(text).length }),
    UniqueID.configure({ types: [...blockTypes, 'extensionInline'], generateID: () => crypto.randomUUID() }),
  ];
}
