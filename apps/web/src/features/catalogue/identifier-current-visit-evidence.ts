import type { Release } from '@rezics/definitions';
import type { SubjectPageData } from '../pages/page-model';
import { subjectBody } from '../pages/subject-read';
import { bestRank, spoilerLevel, type Stmt } from '../pages/shared';
import { defaultReader } from '../../subject/reader';
import { candidateContext } from '../pages/visit-host-port';
import type { Subject, Related } from '../../subject/read-contract';
import { identifierProperties } from './identifiers-profile';
import type { IdentifierInspection, IdentifierVisitOrigin } from './identifier-current-visit';

export type IdentifierEvidence = {
  subject: Omit<Subject, 'statements'> & { statements: Record<string, Stmt[]> };
  related: Related;
  definitions: Pick<Release, 'types' | 'properties'>;
  digest: string;
  properties: string[];
};
export type IdentifierEvidenceRead =
  | { kind: 'ready'; evidence: IdentifierEvidence }
  | { kind: 'changed' | 'missing' | 'refused' | 'unavailable' | 'unsupported' };
export type IdentifierEvidenceTransport = { read: () => Promise<IdentifierEvidenceRead> };

/** The public page selector owns resolution. A different Context is never a substitute origin. */
export function identifierEvidenceFromPage(
  page: SubjectPageData,
  id: string,
  origin?: IdentifierVisitOrigin,
): IdentifierEvidenceRead {
  if (origin?.kind === 'unsupported') return { kind: 'unsupported' };
  const read = subjectBody(page);
  if (!read) return { kind: 'unavailable' };
  const context = origin?.context ?? candidateContext;
  if (page.subject !== id || read.subject.id !== id || read.subject.context !== context) return { kind: 'changed' };
  if (origin?.kind === 'realm') {
    if (
      page.requestedRealm !== origin.realm ||
      page.context?.id !== context ||
      page.context.population.kind !== 'realm' ||
      page.context.population.id !== origin.realm
    )
      return { kind: 'changed' };
  } else if (page.requestedRealm || (page.context && page.context.id !== candidateContext)) {
    return { kind: 'changed' };
  }
  const catalogue = page.catalogue;
  if (
    catalogue?.state !== 'released' ||
    !catalogue.definitions ||
    !catalogue.digest ||
    catalogue.type !== read.subject.type
  )
    return { kind: 'unavailable' };
  const properties = identifierProperties(catalogue.definitions, read.subject.type);
  // Spoiler suppression is the ordinary public reader's gate, before any occurrence reaches this pane.
  const statements = Object.fromEntries(
    properties.map((property) => [
      property,
      bestRank(read.subject.statements[property] ?? []).filter(
        (statement) => spoilerLevel(statement) <= defaultReader.spoilerLevel,
      ),
    ]),
  );
  return {
    kind: 'ready',
    evidence: {
      subject: { ...read.subject, statements },
      related: read.related,
      definitions: catalogue.definitions,
      digest: catalogue.digest,
      properties,
    },
  };
}

export function identifierOccurrence(evidence: IdentifierEvidence, address: IdentifierInspection) {
  return evidence.subject.statements[address.property]?.find((statement) => statement.id === address.statement);
}

/** Return focus requires the same exact assertion, Type, release and Context in the fresh reading. */
export function survivingIdentifierOccurrence(
  previous: IdentifierEvidence,
  current: IdentifierEvidence,
  address: IdentifierInspection,
) {
  const selected = identifierOccurrence(previous, address);
  const returned = identifierOccurrence(current, address);
  return (
    !!selected &&
    !!returned &&
    previous.subject.id === current.subject.id &&
    previous.subject.context === current.subject.context &&
    previous.subject.type === current.subject.type &&
    previous.subject.release === current.subject.release &&
    previous.digest === current.digest &&
    JSON.stringify(selected) === JSON.stringify(returned)
  );
}
