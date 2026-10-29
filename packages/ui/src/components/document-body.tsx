import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentSpoiler } from './document-spoiler.tsx';
import { Prose } from './prose.tsx';
import { documentExtensions } from './document-extensions.ts';
import { safeDocumentUrl } from './document-url.ts';

const rel = 'noopener noreferrer nofollow ugc';

export const documentBodyLabels = {
  revealSpoiler: 'Reveal spoiler',
} as const;

export type DocumentBodyLabels = { readonly [K in keyof typeof documentBodyLabels]: string };

export type DocumentMentions = Readonly<Record<string, { handle: string }>>;
type Props = {
  document: DocumentSnapshot;
  className?: string;
  labels?: Partial<DocumentBodyLabels>;
  mentions?: DocumentMentions;
  locale?: string;
};

/** Render a document snapshot without creating an editor or requiring a browser DOM. */
export function DocumentBody({ document, className, labels, mentions, locale = 'en' }: Props) {
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
        spoiler: ({ children }: any) => <DocumentSpoiler label={resolved.revealSpoiler}>{children}</DocumentSpoiler>,
      },
    },
  });
  return (
    <Prose className={className} data-slot="document-body">
      {content}
    </Prose>
  );
}
