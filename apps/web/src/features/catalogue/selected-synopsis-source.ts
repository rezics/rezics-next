import type { Related } from '../../subject/types';
import { candidateContext } from '../../subject/candidates';
import { synopsisVisit } from '../pages/subject-summary-reading/visit';
import type { Snak } from '../pages/shared';
import type { SourceDefinitions, SourcesResult } from './subject-sources';
import { explainSelectedSynopsisSource } from './subject-sources';

/** Intent admitted at the BFF boundary. It is never returned as public evidence. */
export type SelectedSynopsisSourceIntent = {
  subject: string;
  holder: string;
  property: 'schema:abstract';
  context: string;
  candidate: string;
  document: string;
  digest: string;
  language: string;
  locale: string;
  observedRelease?: string;
  observedRevision?: string;
};

/**
 * Minimal receiving seam for Semantic's selected-slot comparison and Content's
 * independent document admission. The producer returns only disclosed support,
 * after its final native slot check. No document binding or body is a DTO field.
 */
export type SelectedSynopsisSource = {
  subject: string;
  context: string;
  release: string;
  type: string;
  labels: Record<string, string>;
  related: Related;
  statement: {
    id: string;
    property: { id: 'schema:abstract'; data_type: 'document' };
    value: { type: 'somevalue' };
    qualifiers: Snak[];
    references: { parts: Snak[] }[];
  };
};

export type SelectedSynopsisSourceFailure = {
  kind: 'invalid' | 'unsupported' | 'missing' | 'changed' | 'denied' | 'unavailable';
};
export type SelectedSynopsisSourceOutcome =
  | SelectedSynopsisSourceFailure
  | { kind: 'ready'; source: SelectedSynopsisSource };
export type SelectedSynopsisSourceOperation = (
  intent: SelectedSynopsisSourceIntent,
) => Promise<SelectedSynopsisSourceOutcome>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

export type SynopsisSourcesVisit = { sourceView?: 'selected-synopsis'; via?: string };

/** A misspelled explicit visit cannot silently become a general Sources read. */
export function synopsisSourcesVisit(input: { sourceView?: unknown; via?: unknown }): SynopsisSourcesVisit {
  if (input.sourceView === undefined) return {};
  if (
    input.sourceView !== 'selected-synopsis' ||
    typeof input.via !== 'string' ||
    new TextEncoder().encode(input.via).byteLength > 2048
  )
    throw new TypeError('Invalid selected Sources visit');
  return { sourceView: 'selected-synopsis', via: input.via };
}

/** Parse external return intent once, before any native or definition reads. */
export function selectedSynopsisSourceIntent(
  id: string,
  locale: string,
  via: unknown,
  realm?: string,
): SelectedSynopsisSourceFailure | { kind: 'selected'; intent: SelectedSynopsisSourceIntent } {
  const visit = synopsisVisit(via, id, locale);
  if (visit.kind !== 'selected' || !uuid.test(id)) return { kind: 'invalid' };
  const selection = visit.selection;
  if (realm || selection.realm || selection.context !== candidateContext) return { kind: 'unsupported' };
  if (
    !uuid.test(selection.candidateId) ||
    !uuid.test(selection.documentId) ||
    !digest.test(selection.digest) ||
    (selection.release !== undefined && !digest.test(selection.release)) ||
    (selection.source !== undefined && !/^[1-9][0-9]*$/.test(selection.source))
  )
    return { kind: 'invalid' };
  return {
    kind: 'selected',
    intent: {
      subject: id,
      holder: id,
      property: 'schema:abstract',
      context: candidateContext,
      candidate: selection.candidateId,
      document: selection.documentId,
      digest: selection.digest,
      language: selection.language,
      locale,
      ...(selection.release ? { observedRelease: selection.release } : {}),
      ...(selection.source ? { observedRevision: selection.source } : {}),
    },
  };
}

/**
 * One native operation, no candidate enumeration, body fetch, redirect following,
 * sibling choice or general-Sources fallback. A missing producer stays named.
 * Definitions are optional labels, requested only after native admission.
 */
export async function readSelectedSynopsisSources(
  operation: SelectedSynopsisSourceOperation | null,
  request: { id: string; locale: string; via?: string | undefined; realm?: string | undefined },
  definitions?: () => Promise<SourceDefinitions | undefined>,
): Promise<SourcesResult> {
  const admitted = selectedSynopsisSourceIntent(request.id, request.locale, request.via, request.realm);
  if (admitted.kind !== 'selected') return admitted;
  if (!operation) return { kind: 'unsupported' };
  const result = await operation(admitted.intent);
  if (result.kind !== 'ready') return result;
  return {
    kind: 'ready',
    page: explainSelectedSynopsisSource(result.source, request.locale, await definitions?.()),
  };
}
