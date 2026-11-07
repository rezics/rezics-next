import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type {
  SnakInput,
  StatementFieldsRead,
  StatementRelated,
  StatementScalarRead,
} from './statement-editor-contract';
import { isolatedWorkReading, type WorkReadingValueProps } from './work-reading-port';

export type { StatementFieldsRead, StatementRelated, StatementScalarRead };

export type StatementReadingLink = ComponentType<{
  href: string;
  lang?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}>;

export type StatementReadingValueProps = WorkReadingValueProps;

/**
 * Consumer-owned statement value port. Summaries and the editor render terms through `renderValue`.
 * Request/result vocabulary lives in `statement-editor-contract`. Live CandidateValue is bound at
 * page composition and the editor view adapter; uncomposed readers use the isolated renderer.
 */
export type StatementReadingPort = {
  renderValue(props: StatementReadingValueProps): ReactNode;
};

export const StatementReadingContext = createContext<StatementReadingPort | null>(null);

export function StatementReadingProvider({ port, children }: { port: StatementReadingPort; children: ReactNode }) {
  return <StatementReadingContext.Provider value={port}>{children}</StatementReadingContext.Provider>;
}

export function useStatementReading(override?: StatementReadingPort): StatementReadingPort {
  return override ?? useContext(StatementReadingContext) ?? isolatedStatementReading;
}

export function StatementReadingLink({
  href,
  lang,
  className,
  children,
}: {
  href: string;
  lang?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <a href={href} lang={lang} className={className}>
      {children}
    </a>
  );
}

/** Module-local adapter for summaries, stories and tests. Live pages bind CandidateValue. */
export const isolatedStatementReading: StatementReadingPort = {
  renderValue: (props) => isolatedWorkReading.renderValue(props),
};

export function statementPartLabel(part: SnakInput, release: StatementScalarRead['release'], locale: string) {
  const labels = release.properties[part.property.id]?.labels ?? {};
  const picked = pickText(labels, locale);
  return { text: picked.text || part.property.id, language: picked.lang };
}

/** A read-only part still participates in the submitted statement. It is never filtered away. */
export function PartValue({
  part,
  read,
  locale,
  reading,
}: {
  part: SnakInput;
  read: StatementScalarRead;
  locale: string;
  reading?: StatementReadingPort;
}) {
  const port = useStatementReading(reading);
  const definition = read.release.properties[part.property.id];
  if (!definition) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  return port.renderValue({
    snak: { property: { ...part.property, data_type: definition.datatype ?? '' }, value: part.value },
    related: read.public.related,
    locale,
    link: StatementReadingLink,
  });
}
