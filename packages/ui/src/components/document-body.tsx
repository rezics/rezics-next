import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { Fragment, useId, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
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

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function cellWidth(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const width = value.reduce<number>(
    (sum, column) => sum + (typeof column === 'number' ? column : 0),
    0,
  );
  return width > 0 ? width : undefined;
}
function common(node: DocumentNode) {
  return {
    'data-block-id': string(node.attrs?.id),
    lang: string(node.attrs?.lang),
    dir: string(node.attrs?.dir),
    style:
      node.attrs?.textAlign || node.attrs?.align
        ? { textAlign: (node.attrs.textAlign ?? node.attrs.align) as CSSProperties['textAlign'] }
        : undefined,
  };
}

function marked(
  node: DocumentNode,
  spoilerLabel: string,
  base: ReactNode = node.text ?? '',
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
        const href = safeDocumentUrl(attrs.href);
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
          <span key={index} lang={string(attrs.lang)} dir={string(attrs.dir)}>
            {children}
          </span>
        );
      case 'textStyle':
        return (
          <span
            key={index}
            style={{ color: string(attrs.color), backgroundColor: string(attrs.backgroundColor) }}
          >
            {children}
          </span>
        );
      case 'textEmphasis':
        return (
          <span
            key={index}
            style={{
              textEmphasisStyle: `${String(attrs.fill ?? 'filled')} ${String(attrs.shape ?? 'dot')}`,
              textEmphasisPosition: `${String(attrs.position ?? 'over')} right`,
              textEmphasisColor: string(attrs.color),
            }}
          >
            {children}
          </span>
        );
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
    const shared = { ...common(node), ...nodeAttributes?.(node) };
    switch (node.type) {
      case 'doc':
        return children;
      case 'text':
        return marked(node, spoilerLabel, node.text ?? '', revealSpoiler);
      case 'paragraph': {
        const paragraphIndex = paragraph++;
        return renderParagraph ? (
          renderParagraph(node, children, paragraphIndex)
        ) : (
          <p {...shared}>{children?.length ? children : <br />}</p>
        );
      }
      case 'heading': {
        const level = Number(attrs.level);
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
          <ol {...shared} start={Number(attrs.start ?? 1)}>
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
              aria-checked={Boolean(attrs.checked)}
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
            colSpan={Number(attrs.colspan ?? 1)}
            rowSpan={Number(attrs.rowspan ?? 1)}
          >
            {children}
          </td>
        );
      case 'tableHeader':
        return (
          <th
            {...shared}
            style={{ ...shared.style, width: cellWidth(attrs.colwidth) }}
            colSpan={Number(attrs.colspan ?? 1)}
            rowSpan={Number(attrs.rowspan ?? 1)}
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
              rubyPosition: String(attrs.position ?? 'over') as CSSProperties['rubyPosition'],
            }}
          >
            <span>{children}</span>
            <rp>(</rp>
            <rt>{string(attrs.rt)}</rt>
            <rp>)</rp>
          </ruby>,
          revealSpoiler,
        );
      case 'image': {
        const src = safeDocumentUrl(attrs.src, true);
        return (
          <figure {...shared}>
            {src ? (
              <MediaImage
                src={src}
                representationId={string(attrs.representationId)}
                mediaUseId={string(attrs.mediaUseId)}
                conceal={attrs.conceal === true}
                alt={string(attrs.alt) ?? ''}
                title={string(attrs.title)}
                width={typeof attrs.width === 'number' ? attrs.width : undefined}
                height={typeof attrs.height === 'number' ? attrs.height : undefined}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <figcaption>{string(attrs.alt) ?? string(attrs.title)}</figcaption>
            )}
          </figure>
        );
      }
      case 'media': {
        const src = safeDocumentUrl(attrs.src, true);
        const caption = string(attrs.caption);
        if (!src) return <p {...shared}>{caption}</p>;
        return (
          <figure {...shared}>
            {attrs.kind === 'audio' ? (
              <audio controls src={src} preload="none" aria-label={caption} />
            ) : attrs.kind === 'video' ? (
              <video controls src={src} preload="none" aria-label={caption} />
            ) : (
              <a href={src} rel="noopener noreferrer">
                {caption ?? src}
              </a>
            )}
            {caption && attrs.kind !== 'file' ? <figcaption>{caption}</figcaption> : null}
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
        return <span data-unknown-node={node.type}>{children}</span>;
    }
  }
  return (
    <div {...props} className={cn('rezics-document', className)} data-slot="document-body">
      {render(document.doc)}
    </div>
  );
}
