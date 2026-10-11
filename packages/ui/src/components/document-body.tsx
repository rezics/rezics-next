import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { Fragment, useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { safeDocumentUrl } from './document-url.tsx';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { MediaImage } from './media-image.tsx';

export interface DocumentBodyProps extends Omit<ComponentProps<'div'>, 'children'> {
  document: DocumentSnapshot;
  /** The consumer can wrap paragraphs with reading progress, comments or selection controls. */
  renderParagraph?: (node: DocumentNode, children: ReactNode, index: number) => ReactNode;
  /** Reading anchors can follow the document's stable IDs, including headings and components. */
  nodeAttributes?: (node: DocumentNode) => { id?: string; 'data-paragraph'?: number };
  unknownComponentLabel?: string;
  spoilerLabel?: string;
}

function string(value: unknown): string | undefined;
function string<T extends string>(value: unknown, allowed: readonly T[]): T | undefined;
function string(value: unknown, allowed?: readonly string[]): string | undefined {
  return typeof value === 'string' && (!allowed || allowed.includes(value)) ? value : undefined;
}

/** Stored JSON must pass a primitive guard before any coercion or DOM assignment. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}
function positiveInteger(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}
function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function color(value: unknown): string | undefined {
  const text = string(value);
  return text !== undefined && !/[;{}\u0000-\u001f]/u.test(text) ? text : undefined;
}
function cellWidth(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  let width = 0;
  for (const column of value) {
    const number = positiveInteger(column);
    if (number === undefined) return undefined;
    width += number;
  }
  return positiveNumber(width);
}
function common(node: DocumentNode) {
  const textAlign = string(node.attrs?.textAlign ?? node.attrs?.align, [
    'left',
    'center',
    'right',
    'justify',
    'start',
    'end',
  ] as const);
  return {
    'data-block-id': string(node.attrs?.id),
    lang: string(node.attrs?.lang),
    dir: string(node.attrs?.dir, ['ltr', 'rtl', 'auto']),
    style: textAlign ? { textAlign } : undefined,
  };
}

const knownNodeTypes = new Set([
  'doc',
  'text',
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'ruby',
  'image',
  'media',
  'extensionInline',
  'extensionBlock',
]);

/** One bounded fallback; never carries node attributes that could poison the style tree. */
function isolatedPlaceholder(kind: 'unknown' | 'malformed', name: string) {
  return (
    <div
      className="document-component"
      {...(kind === 'unknown' ? { 'data-unknown-node': name } : { 'data-malformed-node': name })}
      role="note"
    />
  );
}

/** Missing level stays the historical h6 default; only a present value outside 1–6 is malformed. */
function headingLevel(value: unknown): 1 | 2 | 3 | 4 | 5 | 6 | 'default' | 'malformed' {
  if (value === undefined) return 'default';
  const level = finiteNumber(value);
  if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6) {
    return level;
  }
  return 'malformed';
}

function marked(
  node: DocumentNode,
  spoilerLabel: string,
  base: ReactNode = string(node.text) ?? '',
  revealSpoiler = false,
): ReactNode {
  const content = (node.marks ?? []).reduce<ReactNode>((children, mark, index) => {
    const attrs = mark.attrs ?? {};
    switch (mark.type) {
      case 'bold':
        return <strong key={index}>{children}</strong>;
      case 'italic':
        return <em key={index}>{children}</em>;
      case 'underline':
        return <u key={index}>{children}</u>;
      case 'strike':
        return <s key={index}>{children}</s>;
      case 'code':
        return <code key={index}>{children}</code>;
      case 'link': {
        const href = safeDocumentUrl(string(attrs.href));
        return href ? (
          <a key={index} href={href} title={string(attrs.title)} rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          children
        );
      }
      case 'language':
        return (
          <span
            key={index}
            lang={string(attrs.lang)}
            dir={string(attrs.dir, ['ltr', 'rtl', 'auto'])}
          >
            {children}
          </span>
        );
      case 'textStyle':
        return (
          <span
            key={index}
            style={{ color: color(attrs.color), backgroundColor: color(attrs.backgroundColor) }}
          >
            {children}
          </span>
        );
      case 'textEmphasis': {
        const fill = string(attrs.fill ?? 'filled', ['filled', 'open']);
        const shape = string(attrs.shape ?? 'dot', [
          'dot',
          'sesame',
          'circle',
          'double-circle',
          'triangle',
        ]);
        const position = string(attrs.position ?? 'over', ['over', 'under']);
        return (
          <span
            key={index}
            style={{
              textEmphasisStyle: fill && shape ? `${fill} ${shape}` : undefined,
              textEmphasisPosition: position ? `${position} right` : undefined,
              textEmphasisColor: color(attrs.color),
            }}
          >
            {children}
          </span>
        );
      }
      default:
        return children;
    }
  }, base);
  return !revealSpoiler && node.marks?.some((mark) => mark.type === 'spoiler') ? (
    <DocumentSpoiler label={spoilerLabel}>{content}</DocumentSpoiler>
  ) : (
    content
  );
}

/** Pure React rendering: does not load an editor, execute components or interpret content as HTML. */
export function DocumentBody({
  document,
  className,
  renderParagraph,
  nodeAttributes,
  unknownComponentLabel = 'Embedded component',
  spoilerLabel = 'Reveal spoiler',
  ...props
}: DocumentBodyProps) {
  const labelPrefix = useId();
  let paragraph = 0;
  let task = 0;
  function render(node: DocumentNode, revealSpoiler = false): ReactNode {
    const attrs = node.attrs ?? {};
    // Do not walk content or read attrs of an unknown node: one marker-only placeholder.
    if (!knownNodeTypes.has(node.type)) {
      return isolatedPlaceholder('unknown', node.type);
    }
    const imageSrc = node.type === 'image' ? safeDocumentUrl(string(attrs.src), true) : undefined;
    if (node.type === 'image' && !imageSrc) {
      return isolatedPlaceholder('malformed', 'image');
    }
    const level = node.type === 'heading' ? headingLevel(attrs.level) : undefined;
    if (level === 'malformed') {
      return isolatedPlaceholder('malformed', 'heading');
    }
    const rubyText = node.type === 'ruby' ? string(attrs.rt) : undefined;
    if (node.type === 'ruby' && rubyText === undefined) {
      return isolatedPlaceholder('malformed', 'ruby');
    }
    const shared = { ...common(node), ...nodeAttributes?.(node) };
    const children: ReactNode[] = [];
    for (let index = 0; index < (node.content?.length ?? 0); index++) {
      const child = node.content![index]!;
      const key = string(child.attrs?.id) ?? index;
      if (!revealSpoiler && child.marks?.some((mark) => mark.type === 'spoiler')) {
        const concealed: ReactNode[] = [];
        let end = index;
        while (
          end < node.content!.length &&
          node.content![end]!.marks?.some((mark) => mark.type === 'spoiler')
        ) {
          const part = node.content![end]!;
          concealed.push(
            <Fragment key={string(part.attrs?.id) ?? end}>{render(part, true)}</Fragment>,
          );
          end++;
        }
        children.push(
          <DocumentSpoiler key={key} label={spoilerLabel}>
            {concealed}
          </DocumentSpoiler>,
        );
        index = end - 1;
      } else children.push(<Fragment key={key}>{render(child, revealSpoiler)}</Fragment>);
    }
    switch (node.type) {
      case 'doc':
        return children;
      case 'text':
        return marked(node, spoilerLabel, string(node.text) ?? '', revealSpoiler);
      case 'paragraph': {
        const paragraphIndex = paragraph++;
        return renderParagraph ? (
          renderParagraph(node, children, paragraphIndex)
        ) : (
          <p {...shared}>{children?.length ? children : <br />}</p>
        );
      }
      case 'heading': {
        if (level === 1) return <h1 {...shared}>{children}</h1>;
        if (level === 2) return <h2 {...shared}>{children}</h2>;
        if (level === 3) return <h3 {...shared}>{children}</h3>;
        if (level === 4) return <h4 {...shared}>{children}</h4>;
        if (level === 5) return <h5 {...shared}>{children}</h5>;
        return <h6 {...shared}>{children}</h6>;
      }
      case 'blockquote':
        return <blockquote {...shared}>{children}</blockquote>;
      case 'codeBlock':
        return (
          <pre {...shared}>
            <code data-language={string(attrs.language)}>{children}</code>
          </pre>
        );
      case 'hardBreak':
        return marked(node, spoilerLabel, <br />, revealSpoiler);
      case 'horizontalRule':
        return <hr {...shared} />;
      case 'bulletList':
        return <ul {...shared}>{children}</ul>;
      case 'orderedList':
        return (
          <ol {...shared} start={positiveInteger(attrs.start ?? 1)}>
            {children}
          </ol>
        );
      case 'listItem':
        return <li {...shared}>{children}</li>;
      case 'taskList':
        return (
          <ul {...shared} data-type="taskList">
            {children}
          </ul>
        );
      case 'taskItem': {
        const taskLabel = `${labelPrefix}-task-${task++}`;
        return (
          <li {...shared} data-type="taskItem">
            <span
              role="checkbox"
              aria-checked={boolean(attrs.checked) ?? false}
              aria-disabled="true"
              aria-labelledby={taskLabel}
            />
            <div id={taskLabel}>{children}</div>
          </li>
        );
      }
      case 'table':
        return (
          <div className="document-table-scroll">
            <table {...shared}>
              <tbody>{children}</tbody>
            </table>
          </div>
        );
      case 'tableRow':
        return <tr {...shared}>{children}</tr>;
      case 'tableCell':
        return (
          <td
            {...shared}
            style={{ ...shared.style, width: cellWidth(attrs.colwidth) }}
            colSpan={positiveInteger(attrs.colspan ?? 1)}
            rowSpan={positiveInteger(attrs.rowspan ?? 1)}
          >
            {children}
          </td>
        );
      case 'tableHeader':
        return (
          <th
            {...shared}
            style={{ ...shared.style, width: cellWidth(attrs.colwidth) }}
            colSpan={positiveInteger(attrs.colspan ?? 1)}
            rowSpan={positiveInteger(attrs.rowspan ?? 1)}
            scope="col"
          >
            {children}
          </th>
        );
      case 'ruby':
        return marked(
          node,
          spoilerLabel,
          <ruby
            {...shared}
            style={{
              rubyPosition: string(attrs.position ?? 'over', ['over', 'under', 'inter-character']),
            }}
          >
            <span>{children}</span>
            <rp>(</rp>
            <rt>{rubyText}</rt>
            <rp>)</rp>
          </ruby>,
          revealSpoiler,
        );
      case 'image': {
        return (
          <figure {...shared}>
            <MediaImage
              src={imageSrc!}
              representationId={string(attrs.representationId)}
              mediaUseId={string(attrs.mediaUseId)}
              conceal={boolean(attrs.conceal) ?? false}
              alt={string(attrs.alt) ?? ''}
              title={string(attrs.title)}
              width={positiveNumber(attrs.width)}
              height={positiveNumber(attrs.height)}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </figure>
        );
      }
      case 'media': {
        const src = safeDocumentUrl(string(attrs.src), true);
        const caption = string(attrs.caption);
        const kind = string(attrs.kind, ['audio', 'video', 'file']);
        if (!src) return <p {...shared}>{caption}</p>;
        return (
          <figure {...shared}>
            {kind === 'audio' ? (
              <audio controls src={src} preload="none" aria-label={caption} />
            ) : kind === 'video' ? (
              <video controls src={src} preload="none" aria-label={caption} />
            ) : (
              <a href={src} rel="noopener noreferrer">
                {caption ?? src}
              </a>
            )}
            {caption && kind !== 'file' ? <figcaption>{caption}</figcaption> : null}
          </figure>
        );
      }
      case 'extensionInline':
        return marked(
          node,
          spoilerLabel,
          <span {...shared} data-document-component={string(attrs.definition)}>
            {string(attrs.fallback) ?? unknownComponentLabel}
          </span>,
          revealSpoiler,
        );
      case 'extensionBlock':
        return (
          <div
            {...shared}
            className="document-component"
            data-document-component={string(attrs.definition)}
          >
            {string(attrs.fallback) ?? unknownComponentLabel}
          </div>
        );
      default:
        return isolatedPlaceholder('unknown', node.type);
    }
  }
  return (
    <div {...props} className={cn('rezics-document', className)} data-slot="document-body">
      {render(document.doc)}
    </div>
  );
}
