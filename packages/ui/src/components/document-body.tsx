import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import { type DocumentSnapshot } from '@rezics/document';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { Prose } from './prose.tsx';
import { documentExtensions } from './document-extensions.ts';
import { safeDocumentUrl } from './document-url.ts';
import { NativeCheckbox } from './native-checkbox.tsx';

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

const DocumentRenderContext = createContext<DocumentBodyLabels>(documentBodyLabels);

/** Stable mark component so a parent re-render does not remount spoilers or drop keyboard focus. */
function SpoilerMark({ children }: { children?: ReactNode }) {
  const labels = useContext(DocumentRenderContext);
  return <DocumentSpoiler label={labels.revealSpoiler}>{children}</DocumentSpoiler>;
}

type Props = {
  document: DocumentSnapshot;
  className?: string;
  labels?: Partial<DocumentBodyLabels>;
  mentions?: DocumentMentions;
  locale?: string;
  /** A reader without current native derivative summaries must render explicit unavailability, never guess a URL. */
  renderImage?: (image: { mediaId: string; alt: string }) => ReactNode;
};

/** Render a document snapshot without creating an editor or requiring a browser DOM. */
export function DocumentBody({ document, className, labels, mentions, locale = 'en', renderImage }: Props) {
  const semanticSnapshot = semanticSnapshotJson(document);
  const [visit, setVisit] = useState(() => ({ semanticSnapshot, id: 0 }));
  if (visit.semanticSnapshot !== semanticSnapshot) {
    // Restart this render before its children commit so replacement text cannot paint revealed.
    setVisit({ semanticSnapshot, id: visit.id + 1 });
    return null;
  }

  const resolved = { ...documentBodyLabels, ...labels };
  const content = renderToReactElement({
    extensions: documentExtensions,
    content: document.doc,
    options: {
      nodeMapping: {
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
          if (node.type.name === 'mention') return <>{children}</>;
          const href = safeDocumentUrl(mark.attrs?.href);
          return href ? (
            <a href={href} rel={rel}>
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
    <DocumentRenderContext.Provider value={resolved}>
      <Prose className={className} data-slot="document-body">
        {content}
      </Prose>
    </DocumentRenderContext.Provider>
  );
}
