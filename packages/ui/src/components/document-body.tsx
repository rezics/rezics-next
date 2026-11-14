import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import { type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import {
  createContext,
  createElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { Prose } from './prose.tsx';
import { documentExtensions } from './document-extensions.ts';
import { safeDocumentUrl } from './document-url.ts';
import { NativeCheckbox } from './native-checkbox.tsx';

export { safeDocumentUrl } from './document-url.ts';

const rel = 'noopener noreferrer nofollow ugc';

type AuthoredBlockAttributes = {
  'data-block-id'?: string;
  lang?: string;
  dir?: string;
};

/** Project only the document's common block fields onto rendered output. */
function authoredBlockAttributes(node: DocumentNode): AuthoredBlockAttributes {
  const attrs = node.attrs as { id?: string | null; lang?: string | null; dir?: string | null } | undefined;
  return {
    ...(attrs?.id == null ? {} : { 'data-block-id': attrs.id }),
    ...(attrs?.lang == null ? {} : { lang: attrs.lang }),
    ...(attrs?.dir == null ? {} : { dir: attrs.dir }),
  };
}

/** Keep default semantic roots intact; caller-owned replacements get an anchor wrapper. */
function authoredCallbackBlock(node: DocumentNode, defaultContent: ReactNode, content: ReactNode): ReactNode {
  return content === defaultContent ? content : <div {...authoredBlockAttributes(node)}>{content}</div>;
}

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
  goToFootnote: 'Go to footnote',
  footnote: 'Footnote',
  footnotes: 'Footnotes',
  taskStatus: 'Task status',
  embeddedComponent: 'Embedded component',
  imageUnavailable: 'Image unavailable',
} as const;

export type DocumentBodyLabels = {
  readonly revealSpoiler: string;
  readonly goToFootnote?: string;
  readonly footnote?: string;
  readonly footnotes?: string;
  readonly taskStatus?: string;
  readonly embeddedComponent?: string;
  readonly imageUnavailable?: string;
};

export type DocumentMentions = Readonly<Record<string, { handle: string }>>;

type DocumentRenderValue = {
  labels: DocumentBodyLabels;
  revealed: ReadonlySet<number>;
  footnoteTargets: ReadonlyMap<string, string>;
  reveal: (index: number) => void;
  spoilerIndex: (node: object) => number;
};

const DocumentRenderContext = createContext<DocumentRenderValue | null>(null);

/** Index definitions and visible references once; footnote bodies are rendered only on disclosure. */
function indexDocumentFootnotes(document: DocumentSnapshot) {
  const definitions = new Map<string, { document: DocumentSnapshot; definition: DocumentNode }>();
  const references = new Set<string>();
  const visit = (node: DocumentNode) => {
    if (node.type === 'footnoteReference') {
      references.add(String(node.attrs?.label));
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of document.doc.content ?? []) {
    if (node.type === 'footnoteDefinition') {
      const label = String(node.attrs?.label);
      definitions.set(label, {
        definition: node,
        document: {
          version: document.version,
          profile: document.profile,
          doc: { type: 'doc', content: node.content ?? [] },
        },
      });
    } else visit(node);
  }
  return new Map([...definitions].filter(([label]) => references.has(label)));
}

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

/** Local references navigate to one shared disclosure per supplied definition. */
function FootnoteReference({ node }: { node: { attrs?: Record<string, unknown> } }) {
  const render = useContext(DocumentRenderContext);
  const label = String(node.attrs?.label ?? '');
  const target = render?.footnoteTargets.get(label);
  if (!render || !target) return <>[{label}]</>;
  return (
    <a href={`#${target}`} aria-label={`${render.labels.goToFootnote ?? 'Go to footnote'} ${label}`}>
      <sup>{label}</sup>
    </a>
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
  /** Mention node ordinals, including unresolved and concealed occurrences. */
  mentionAttributes?: (occurrence: number) => DocumentLinkAttributes | undefined;
  /** Spoiler mark positions in document order, from the renderer's live disclosure authority. */
  onDisclosureChange?: (revealed: ReadonlySet<number>) => void;
  /** Reader-owned key for retiring disclosure state when an equal snapshot changes source or revision. */
  visitKey?: string;
  /** A reader without current native derivative summaries must render explicit unavailability, never guess a URL. */
  renderImage?: (image: { mediaId: string; alt: string }) => ReactNode;
  /** Optional published-reader ports. Occurrence is zero-based among authored nodes of the same type. */
  renderCodeBlock?: (
    node: DocumentNode,
    children: ReactNode,
    defaultContent: ReactNode,
    occurrence: number,
  ) => ReactNode;
  renderTable?: (node: DocumentNode, children: ReactNode, defaultContent: ReactNode, occurrence: number) => ReactNode;
};

/** Render a document snapshot without creating an editor or requiring a browser DOM. */
export function DocumentBody({
  document,
  className,
  labels,
  mentions,
  locale = 'en',
  visitKey,
  renderImage,
  renderCodeBlock,
  renderTable,
  headingAttributes,
  linkAttributes,
  mentionAttributes,
  onDisclosureChange,
}: Props) {
  // Published readers admit immutable snapshots; ordinary consumers retain semantic replacement detection.
  const anchored = !!headingAttributes;
  const cachedSemantic = useMemo(() => (anchored ? semanticSnapshotJson(document) : null), [document, anchored]);
  const semanticSnapshot = cachedSemantic ?? semanticSnapshotJson(document);
  const footnotes = useMemo(() => indexDocumentFootnotes(document), [document]);
  const readerId = useId();
  const footnoteTargets = useMemo(
    () =>
      new Map([...footnotes.keys()].map((label, index) => [label, `document-footnote-${readerId}-${index}`] as const)),
    [footnotes, readerId],
  );
  const [visit, setVisit] = useState(() => ({ semanticSnapshot, visitKey, id: 0 }));
  const [, setFootnoteRevision] = useState(false);
  const concealment = useRef({ id: 0, revealed: new Set<number>(), revealedFootnotes: new Set<string>() });
  if (visit.semanticSnapshot !== semanticSnapshot || visit.visitKey !== visitKey) {
    // Restart this render before its children commit so replacement text cannot paint revealed.
    const id = visit.id + 1;
    concealment.current = { id, revealed: new Set(), revealedFootnotes: new Set() };
    setVisit({ semanticSnapshot, visitKey, id });
    return null;
  }
  if (concealment.current.id !== visit.id) {
    concealment.current = { id: visit.id, revealed: new Set(), revealedFootnotes: new Set() };
  }

  const visitId = visit.id;
  const reveal = (index: number) => {
    if (concealment.current.id !== visitId) return;
    concealment.current.revealed.add(index);
    onDisclosureChange?.(new Set(concealment.current.revealed));
  };
  const toggleFootnote = (label: string, expanded: boolean) => {
    if (concealment.current.id !== visitId) return;
    const currentlyExpanded = concealment.current.revealedFootnotes.has(label);
    if (currentlyExpanded === expanded) return;
    if (expanded) concealment.current.revealedFootnotes.add(label);
    else concealment.current.revealedFootnotes.delete(label);
    setFootnoteRevision((revision) => !revision);
  };
  let spoilerIndex = 0;
  const spoilerPositions = new WeakMap<object, number>();
  const resolved = { ...documentBodyLabels, ...labels };
  const renderValue: DocumentRenderValue = {
    labels: resolved,
    revealed: concealment.current.revealed,
    footnoteTargets,
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
  let mentionOccurrence = 0;
  const codeBlockOccurrences = new WeakMap<object, number>();
  const tableOccurrences = new WeakMap<object, number>();
  let codeBlockOccurrence = 0;
  let tableOccurrence = 0;
  const visibleBlocks = (document.doc.content ?? []).filter((node) => node.type !== 'footnoteDefinition');
  const hasVisibleBlocks = visibleBlocks.length > 0;
  const renderedContent = renderToReactElement({
    extensions: documentExtensions,
    content: {
      type: 'doc',
      content: hasVisibleBlocks ? visibleBlocks : [{ type: 'paragraph' }],
    },
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
                    ...authoredBlockAttributes(node),
                    draggable: 'true',
                    ...attributes,
                  },
                  children,
                );
              },
            }
          : {}),
        mention: ({ node }: any) => {
          const occurrence = mentionOccurrence++;
          const account = Object.hasOwn(mentions ?? {}, node.attrs?.accountId)
            ? mentions?.[node.attrs.accountId]
            : undefined;
          return account ? (
            <a
              href={`/${encodeURIComponent(locale)}/@${encodeURIComponent(account.handle)}`}
              {...mentionAttributes?.(occurrence)}
            >
              @{account.handle}
            </a>
          ) : (
            <>@</>
          );
        },
        footnoteReference: ({ node }: any) => <FootnoteReference node={node} />,
        horizontalRule: ({ node }: any) => <hr {...authoredBlockAttributes(node)} />,
        image: ({ node }: any) => {
          const id = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
          if (renderImage)
            return (
              <div {...authoredBlockAttributes(node)}>{renderImage({ mediaId: id, alt: node.attrs?.alt ?? '' })}</div>
            );
          const alt = node.attrs?.alt ?? '';
          return (
            <span
              className="block rounded-xl bg-muted p-5 text-sm text-muted-foreground"
              {...authoredBlockAttributes(node)}
              role="img"
              aria-label={alt || resolved.imageUnavailable}
            >
              {resolved.imageUnavailable}
              {alt ? ` — ${alt}` : ''}
            </span>
          );
        },
        media: ({ node, children }: any) => (
          <figure {...authoredBlockAttributes(node)}>
            {children}
            <figcaption>{node.attrs?.caption}</figcaption>
          </figure>
        ),
        taskItem: ({ node, children }: any) => (
          <li {...authoredBlockAttributes(node)}>
            <NativeCheckbox checked={node.attrs?.checked ?? false} disabled aria-label={resolved.taskStatus} />
            {children}
          </li>
        ),
        codeBlock: ({ node, children }: any) => {
          let occurrence = codeBlockOccurrences.get(node);
          if (occurrence === undefined) {
            occurrence = codeBlockOccurrence++;
            codeBlockOccurrences.set(node, occurrence);
          }
          const defaultContent = (
            <pre {...authoredBlockAttributes(node)}>
              <code data-language={node.attrs?.language ?? undefined}>{children}</code>
            </pre>
          );
          return renderCodeBlock
            ? authoredCallbackBlock(node, defaultContent, renderCodeBlock(node, children, defaultContent, occurrence))
            : defaultContent;
        },
        table: ({ node, children }: any) => {
          let occurrence = tableOccurrences.get(node);
          if (occurrence === undefined) {
            occurrence = tableOccurrence++;
            tableOccurrences.set(node, occurrence);
          }
          const caption = typeof node.attrs?.caption === 'string' ? node.attrs.caption : undefined;
          const defaultContent = (
            <div className="document-table-scroll" {...authoredBlockAttributes(node)}>
              <table>
                {caption !== undefined ? <caption>{caption}</caption> : null}
                <tbody>{children}</tbody>
              </table>
            </div>
          );
          return renderTable
            ? authoredCallbackBlock(node, defaultContent, renderTable(node, children, defaultContent, occurrence))
            : defaultContent;
        },
        tableHeader: ({ node, children }: any) => (
          <th
            scope="col"
            colSpan={positiveCellSpan(node.attrs?.colspan)}
            rowSpan={positiveCellSpan(node.attrs?.rowspan)}
            {...authoredBlockAttributes(node)}
          >
            {children}
          </th>
        ),
        extensionBlock: ({ node }: any) => (
          <div data-document-component={node.attrs?.definition} {...authoredBlockAttributes(node)}>
            {node.attrs?.fallback ?? resolved.embeddedComponent}
          </div>
        ),
        extensionInline: ({ node }: any) => (
          <span data-document-component={node.attrs?.definition} {...authoredBlockAttributes(node)}>
            {node.attrs?.fallback ?? resolved.embeddedComponent}
          </span>
        ),
      },
      markMapping: {
        link: ({ mark, children, node }: any) => {
          if (node.type.name === 'footnoteReference') return <>{children}</>;
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
  const content = hasVisibleBlocks ? renderedContent : null;
  return (
    <DocumentRenderContext.Provider value={renderValue}>
      <Prose className={className} data-slot="document-body">
        {content}
        {footnotes.size ? (
          <section
            className="mt-4 border-t pt-3"
            data-slot="document-footnotes"
            aria-label={resolved.footnotes ?? 'Footnotes'}
          >
            <ol className="list-decimal space-y-2 pl-5">
              {[...footnotes].map(([label, footnote]) => {
                const target = footnoteTargets.get(label)!;
                const expanded = concealment.current.revealedFootnotes.has(label);
                return (
                  <li key={label}>
                    <details open={expanded} onToggle={(event) => toggleFootnote(label, event.currentTarget.open)}>
                      <summary id={target} className="cursor-pointer">
                        {resolved.footnote ?? 'Footnote'} {label}
                      </summary>
                      {expanded ? (
                        <div className="mt-2" {...authoredBlockAttributes(footnote.definition)}>
                          <DocumentBody
                            document={footnote.document}
                            labels={labels}
                            mentions={mentions}
                            locale={locale}
                            visitKey={JSON.stringify([visitId, visitKey, 'footnote', label])}
                            renderImage={renderImage}
                            renderCodeBlock={renderCodeBlock}
                            renderTable={renderTable}
                          />
                        </div>
                      ) : null}
                    </details>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
      </Prose>
    </DocumentRenderContext.Provider>
  );
}

function positiveCellSpan(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
