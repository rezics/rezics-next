import type { WorkPageMessages } from './messages.ts';

export interface PublicDomainSource {
  record: string; observation: string; provider: string; externalId: string; url: string;
}

/** Read only the selected publication's public source contract. Intake evidence is not publication clearance. */
export function publicationSource(header: unknown): PublicDomainSource | null {
  if (!header || typeof header !== 'object' || !('rights' in header)) return null;
  const rights = header.rights;
  if (!rights || typeof rights !== 'object' || !('basis' in rights) || rights.basis !== 'public-domain'
    || !('source' in rights) || !rights.source || typeof rights.source !== 'object') return null;
  const source = rights.source as Record<string, unknown>;
  if (['record', 'observation', 'provider', 'externalId', 'url'].some(key => typeof source[key] !== 'string'
    || !source[key])) return null;
  try {
    const url = new URL(source.url as string);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch { return null; }
  return source as unknown as PublicDomainSource;
}

export function PublicationSource({ source, messages }: { source: PublicDomainSource | null; messages: WorkPageMessages }) {
  return source ? <p className="break-words text-muted-foreground text-sm" data-publication-source>
    {messages.publicDomainSource}{': '}<a href={source.url} rel="noreferrer"
      className="text-primary underline underline-offset-4">{source.provider} · {source.externalId}</a>
  </p> : null;
}
