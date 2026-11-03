import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import { type DocumentSnapshot } from '@rezics/document';
import { createContext, createElement, useContext, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { Prose } from './prose.tsx';
import { documentExtensions } from './document-extensions.ts';
import { safeDocumentUrl } from './document-url.ts';
import { NativeCheckbox } from './native-checkbox.tsx';

export { safeDocumentUrl } from './document-url.ts';

const rel = 'noopener noreferrer nofollow ugc';

function semanticSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(semanticSnapshotJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${semanticSnapshotJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const documentBodyLabels = {
  revealSpoiler: 'Reveal spoiler',
  taskStatus: 'Task status',
  embeddedComponent: 'Embedded component',
  imageUnavailable: 'Image unavailable',
} as const;

export type DocumentBodyLabels = {
  readonly revealSpoiler: string;
  readonly taskStatus?: string;
  readonly embeddedComponent?: string;
  readonly imageUnavailable?: string;
};

export type DocumentMentions = Readonly<Record<string, { handle: string }>>;

type DocumentRenderValue = {
  labels: DocumentBodyLabels;
  visitId: number;
  revealed: ReadonlySet<number>;
  reveal: (index: number) => void;
  spoilerIndex: (node: object) => number;
};

const DocumentRenderContext = createContext<DocumentRenderValue | null>(null);

/** Stable mark component; visit-scoped revealed indices restore after a parent re-render remounts. */
function SpoilerMark({ children, node }: { children?: ReactNode; node: object }) {
  const render = useContext(DocumentRenderContext);
  if (!render) return <DocumentSpoiler>{children}</DocumentSpoiler>;
  const index = render.spoilerIndex(node);
  return (
    <DocumentSpoiler
      label={render.labels.revealSpoiler}
      initialRevealed={render.revealed.has(index)}
      onReveal={() => render.reveal(index)}
    >
      {children}
    </DocumentSpoiler>
  );
}

/** Optional local reading anchors; no URLs, labels or document mutation. */
export type DocumentHeadingAttributes = {
  id: string;
  tabIndex: -1;
  ref: Ref<HTMLHeadingElement>;
};

/** Optional local source targets for admitted link occurrences. */
export type DocumentLinkAttributes = {
  id?: string;
  ref?: Ref<HTMLAnchorElement>;
};

type Props = {
  document: DocumentSnapshot;
  className?: string;
  labels?: Partial<DocumentBodyLabels>;
  mentions?: DocumentMentions;
  locale?: string;
  /** Existing admitted node identity, independent of render attempts or heading text. */
  headingAttributes?: (nodeId: string) => DocumentHeadingAttributes | undefined;
  /** Optional occurrence-indexed attributes; omitted consumers keep their ordinary anchor markup. */
  linkAttributes?: (occurrence: number) => DocumentLinkAttributes | undefined;
  /** Spoiler mark positions in document order, from the renderer's live disclosure authority. */
  onDisclosureChange?: (revealed: ReadonlySet<number>) => void;
  /** A reader without current native derivative summaries must render explicit unavailability, never guess a URL. */
  renderImage?: (image: { mediaId: string; alt: string }) => ReactNode;
};

/** Render a document snapshot without creating an editor or requiring a browser DOM. */
export function DocumentBody({
  document,
  className,
  labels,
  mentions,
  locale = 'en',
  renderImage,
  headingAttributes,
  linkAttributes,
  onDisclosureChange,
}: Props) {
  // Published readers admit immutable snapshots; ordinary consumers retain semantic replacement detection.
  const anchored = !!headingAttributes;
  const cachedSemantic = useMemo(() => (anchored ? semanticSnapshotJson(document) : null), [document, anchored]);
  const semanticSnapshot = cachedSemantic ?? semanticSnapshotJson(document);
  const [visit, setVisit] = useState(() => ({ semanticSnapshot, id: 0 }));
  const concealment = useRef({ id: 0, revealed: new Set<number>() });
  if (visit.semanticSnapshot !== semanticSnapshot) {
    // Restart this render before its children commit so replacement text cannot paint revealed.
    const id = visit.id + 1;
    concealment.current = { id, revealed: new Set() };
    setVisit({ semanticSnapshot, id });
    return null;
  }
  if (concealment.current.id !== visit.id) {
    concealment.current = { id: visit.id, revealed: new Set() };
  }

  const visitId = visit.id;
  const reveal = (index: number) => {
    if (concealment.current.id !== visitId) return;
    concealment.current.revealed.add(index);
    onDisclosureChange?.(new Set(concealment.current.revealed));
  };
  let spoilerIndex = 0;
  const spoilerPositions = new WeakMap<object, number>();
  const resolved = { ...documentBodyLabels, ...labels };
  const renderValue: DocumentRenderValue = {
    labels: resolved,
    visitId,
    revealed: concealment.current.revealed,
    reveal,
    spoilerIndex: (node) => {
      const known = spoilerPositions.get(node);
      if (known !== undefined) return known;
      const index = spoilerIndex++;
      spoilerPositions.set(node, index);
      return index;
    },
  };
  let linkOccurrence = 0;
  const content = renderToReactElement({
    extensions: documentExtensions,
    content: document.doc,
    options: {
      nodeMapping: {
        // Without the optional port, the installed extension retains its exact default markup.
        ...(headingAttributes
          ? {
              heading: ({ node, children }: any) => {
                const attributes = headingAttributes(node.attrs.id ?? '');
                return createElement(
                  `h${node.attrs.level}`,
                  {
                    'data-block-id': node.attrs.id ?? undefined,
                    lang: node.attrs.lang ?? undefined,
                    dir: node.attrs.dir ?? undefined,
                    draggable: 'true',
                    ...attributes,
                  },
                  children,
                );
              },
            }
          : {}),
        mention: ({ node }: any) => {
          const account = Object.hasOwn(mentions ?? {}, node.attrs?.accountId)
            ? mentions?.[node.attrs.accountId]
            : undefined;
          return account ? (
            <a href={`/${encodeURIComponent(locale)}/@${encodeURIComponent(account.handle)}`}>@{account.handle}</a>
          ) : (
            <>@</>
          );
        },
        horizontalRule: () => <hr />,
        image: ({ node }: any) => {
          const id = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
          if (renderImage) return renderImage({ mediaId: id, alt: node.attrs?.alt ?? '' });
          const alt = node.attrs?.alt ?? '';
          return (
            <span
              className="block rounded-xl bg-muted p-5 text-sm text-muted-foreground"
              role="img"
              aria-label={alt || resolved.imageUnavailable}
            >
              {resolved.imageUnavailable}
              {alt ? ` — ${alt}` : ''}
            </span>
          );
        },
        media: ({ node, children }: any) => (
          <figure>
            {children}
            <figcaption>{node.attrs?.caption}</figcaption>
          </figure>
        ),
        taskItem: ({ node, children }: any) => (
          <li>
            <NativeCheckbox checked={node.attrs?.checked ?? false} disabled aria-label={resolved.taskStatus} />
            {children}
          </li>
        ),
        codeBlock: ({ node, children }: any) => (
          <pre>
            <code data-language={node.attrs?.language ?? undefined}>{children}</code>
          </pre>
        ),
        table: ({ children }: any) => (
          <div className="document-table-scroll">
            <table>
              <tbody>{children}</tbody>
            </table>
          </div>
        ),
        tableHeader: ({ children }: any) => <th scope="col">{children}</th>,
        extensionBlock: ({ node }: any) => (
          <div data-document-component={node.attrs?.definition}>
            {node.attrs?.fallback ?? resolved.embeddedComponent}
          </div>
        ),
        extensionInline: ({ node }: any) => (
          <span data-document-component={node.attrs?.definition}>
            {node.attrs?.fallback ?? resolved.embeddedComponent}
          </span>
        ),
      },
      markMapping: {
        link: ({ mark, children, node }: any) => {
          const occurrence = linkOccurrence++;
          if (node.type.name === 'mention') return <>{children}</>;
          const href = safeDocumentUrl(mark.attrs?.href);
          return href ? (
            <a
              href={href}
              rel={rel}
              title={typeof mark.attrs?.title === 'string' ? mark.attrs.title : undefined}
              {...linkAttributes?.(occurrence)}
            >
              {children}
            </a>
          ) : (
            <>{children}</>
          );
        },
        spoiler: SpoilerMark,
      },
    },
  });
  return (
    <DocumentRenderContext.Provider value={renderValue}>
      <Prose className={className} data-slot="document-body">
        {content}
      </Prose>
    </DocumentRenderContext.Provider>
  );
}
