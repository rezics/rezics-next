import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { documentExtensions } from './document-extensions.ts';
import { safeDocumentUrl } from './document-url.ts';

const rel = 'noopener noreferrer nofollow ugc';
type Props = { document: DocumentSnapshot; className?: string };

/** Render a document snapshot without creating an editor or requiring a browser DOM. */
export function DocumentBody({ document, className }: Props) {
  const content = renderToReactElement({
    extensions: documentExtensions,
    content: document.doc,
    options: {
      nodeMapping: {
        horizontalRule: () => <hr />,
        image: ({ node }: any) => {
          const id = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
          const variant = typeof node.attrs?.variant === 'string' ? node.attrs.variant : 'original';
          return (
            <img
              src={`/media/${encodeURIComponent(id)}/${encodeURIComponent(variant)}`}
              alt={node.attrs?.alt ?? ''}
              loading="lazy"
              width={node.attrs?.width ?? undefined}
              height={node.attrs?.height ?? undefined}
            />
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
            <input type="checkbox" checked={node.attrs?.checked ?? false} disabled aria-label="Task status" />
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
          <div data-document-component={node.attrs?.definition}>{node.attrs?.fallback ?? 'Embedded component'}</div>
        ),
        extensionInline: ({ node }: any) => (
          <span data-document-component={node.attrs?.definition}>{node.attrs?.fallback ?? 'Embedded component'}</span>
        ),
      },
      markMapping: {
        link: ({ mark, children }: any) => {
          const href = safeDocumentUrl(mark.attrs?.href);
          return href ? (
            <a href={href} rel={rel}>
              {children}
            </a>
          ) : (
            <>{children}</>
          );
        },
        spoiler: ({ children }: any) => <DocumentSpoiler>{children}</DocumentSpoiler>,
      },
    },
  });
  return (
    <div
      className={`rezics-document space-y-4 text-foreground [&_a]:text-primary [&_a]:underline ${className ?? ''}`}
      data-slot="document-body"
    >
      {content}
    </div>
  );
}
