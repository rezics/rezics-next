import type { KernelClient, SubjectRead } from '@rezics/client';
import type { PropertyDefinition, Release, TypeDefinition } from '@rezics/definitions';
import { checkStatementInput } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import {
  candidateContext,
  candidateFailure,
  readCandidates,
  selectCandidate,
  type Candidate,
  type CandidateCommand,
  type CandidateFailure,
  type CandidatePage,
  type CandidateSlot,
  type CandidateResult,
} from './candidates';

export type RelationSlot = CandidateSlot & { property: string };
export type RelationQualifier = {
  id: string;
  label: string;
  datatype: PropertyDefinition['datatype'];
  targets: readonly string[];
};
export type RelationField = RelationQualifier & {
  group: string;
  disclosure?: 'sourceOrConsent';
  slotKey?: string;
  qualifiers: RelationQualifier[];
};
export type RelationTypeDescriptor = {
  typeId: string;
  releaseDigest: string;
  definition: TypeDefinition;
  properties: Record<string, PropertyDefinition>;
};
export type RelationTypeDescriptorRead =
  | { ok: true; descriptor: RelationTypeDescriptor }
  | { ok: false; reason: 'missing' | 'unavailable' };
export type RelationTypeDescriptorReader = (typeId: string, locale: string) => Promise<RelationTypeDescriptorRead>;
export type RelationRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      descriptor?: RelationTypeDescriptor;
      fields: RelationField[];
      names: Record<string, Record<string, string>>;
      page: CandidatePage | null;
      session?: string;
    };
export type RelationDraft = Pick<Candidate['statement'], 'property' | 'value' | 'qualifiers'> & {
  references: { parts: Candidate['statement']['qualifiers'] }[];
};
type InputSnak = { property: { id: string }; value: RelationDraft['value'] };
export type RelationStatementInput = InputSnak & {
  qualifiers: InputSnak[];
  references: { parts: InputSnak[] }[];
};
export type RelationProposal = {
  id: string;
  slot: RelationSlot;
  statement: RelationDraft;
  key: string;
  /** Sent only when replaying a command whose first native response was uncertain. */
  retry?: true;
};
export type RelationConfirmation = Omit<CandidateCommand, 'property' | 'slot' | 'operation'> & {
  slot: RelationSlot;
  operation: 'accept' | 'reject' | 'adopt';
  cursor?: string;
};
export type RelationResult = CandidateResult | { ok: true; kind: 'rejected'; public: SubjectRead | null };
export type RelationProposalResult =
  | (CandidateFailure & { retry?: true })
  | { ok: true; candidate: string; session?: string };
export type RelationTransport = {
  read: (slot?: RelationSlot, cursor?: string, session?: string) => Promise<RelationRead>;
  propose: (input: RelationProposal) => Promise<RelationProposalResult>;
  confirm: (input: RelationConfirmation) => Promise<RelationResult>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validRelationSlot(slot: RelationSlot): boolean {
  return (
    typeof slot.property === 'string' &&
    slot.property.length > 0 &&
    slot.property.length <= 256 &&
    ((slot.target !== undefined && uuid.test(slot.target) && slot.sameAs === undefined) ||
      (slot.sameAs !== undefined &&
        slot.target === undefined &&
        /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(slot.sameAs))) &&
    (slot.key === undefined || (slot.target !== undefined && uuid.test(slot.key)))
  );
}

/** The exact released Type descriptor owns admission; classifications remain in scalar review. */
export function relationFields(descriptor: RelationTypeDescriptor, locale: string): RelationField[];
/** Profile-specific editors still consume their already selected full release. */
export function relationFields(release: Release, type: string, locale: string): RelationField[];
export function relationFields(
  metadata: RelationTypeDescriptor | Release,
  typeOrLocale: string,
  selectedLocale?: string,
): RelationField[] {
  const descriptor = selectedLocale === undefined ? (metadata as RelationTypeDescriptor) : undefined;
  const release = selectedLocale === undefined ? undefined : (metadata as Release);
  const locale = selectedLocale ?? typeOrLocale;
  const properties = descriptor?.properties ?? release!.properties;
  const propertyIds = descriptor?.definition.properties ?? release!.types[typeOrLocale]?.properties ?? [];
  const named = (id: string): RelationQualifier | undefined => {
    const property = properties[id];
    const label = property && pickText(property.labels, locale).text;
    return label ? { id, label, datatype: property!.datatype, targets: property!.targets ?? [] } : undefined;
  };
  return propertyIds
    .flatMap((id) => {
      const property = properties[id];
      const field = named(id);
      if (
        !field ||
        property?.datatype !== 'wikibase-item' ||
        !property.relation ||
        property.relation.group === 'classification'
      )
        return [];
      return [
        {
          ...field,
          group: property.relation.group,
          ...(property.disclosure ? { disclosure: property.disclosure } : {}),
          ...(property.relation.slotKey ? { slotKey: property.relation.slotKey } : {}),
          qualifiers: property.qualifiers.flatMap((id) => {
            const value = named(id);
            return value ? [value] : [];
          }),
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

function completeRelationDescriptor(descriptor: RelationTypeDescriptor, typeId: string): boolean {
  if (
    descriptor.typeId !== typeId ||
    typeof descriptor.releaseDigest !== 'string' ||
    !descriptor.releaseDigest ||
    !descriptor.definition ||
    !Array.isArray(descriptor.definition.properties) ||
    !descriptor.properties ||
    typeof descriptor.properties !== 'object'
  )
    return false;
  for (const id of descriptor.definition.properties) {
    const property = descriptor.properties[id];
    if (!property || !property.labels || typeof property.labels !== 'object' || !Object.keys(property.labels).length)
      return false;
    if (property.relation && property.relation.group !== 'classification') {
      if (!Array.isArray(property.qualifiers)) return false;
      for (const qualifier of property.qualifiers) {
        const definition = descriptor.properties[qualifier];
        if (!definition || !definition.labels || !Object.keys(definition.labels).length) return false;
      }
    }
  }
  return true;
}

export function relationSlotMatches(
  statement: Candidate['statement'] | RelationDraft,
  slot: RelationSlot,
  field: RelationField,
): boolean {
  if (statement.property.id !== slot.property || !validRelationSlot(slot)) return false;
  if (slot.target !== undefined) {
    const key = field.slotKey ? statement.qualifiers.find((snak) => snak.property.id === field.slotKey) : undefined;
    return (
      statement.value.type === 'value' &&
      statement.value.content === slot.target &&
      (!field.slotKey || (key?.value.type === 'value' ? key.value.content : undefined) === slot.key)
    );
  }
  return (
    statement.value.type === 'somevalue' &&
    statement.qualifiers.some(
      (snak) =>
        snak.property.id === 'schema:sameAs' && snak.value.type === 'value' && snak.value.content === slot.sameAs,
    )
  );
}

export function relationDraft(statement: Candidate['statement']): RelationDraft {
  return structuredClone({
    property: statement.property,
    value: statement.value,
    qualifiers: statement.qualifiers,
    references: statement.references.map(({ parts }) => ({ parts })),
  });
}

/** Native inputs omit the datatype and reference hashes supplied only by read DTOs. */
function statementInput(draft: RelationDraft): RelationStatementInput {
  const snak = ({ property, value }: InputSnak): InputSnak => ({ property: { id: property.id }, value });
  return {
    ...snak(draft),
    qualifiers: draft.qualifiers.map(snak),
    references: draft.references.map(({ parts }) => ({ parts: parts.map(snak) })),
  };
}

export async function readRelationEditor(
  client: KernelClient,
  authorization: string,
  descriptor: RelationTypeDescriptorReader,
  id: string,
  locale: string,
  slot?: RelationSlot,
  cursor?: string,
  session?: string,
): Promise<RelationRead> {
  if (slot && !validRelationSlot(slot)) return candidateFailure(400);
  const result = await readCandidates(client, authorization, id, slot?.property, cursor, slot, session);
  if (!result.ok) return result;
  if (result.public.subject.id !== id || result.public.subject.context !== candidateContext)
    return candidateFailure(400);
  let exact: RelationTypeDescriptorRead;
  try {
    exact = await descriptor(result.public.subject.type, locale);
  } catch {
    return candidateFailure(503);
  }
  if (!exact.ok || !completeRelationDescriptor(exact.descriptor, result.public.subject.type))
    return candidateFailure(503);
  const fields = relationFields(exact.descriptor, locale);
  if (
    slot &&
    (!validRelationSlot(slot) || !fields.some((field) => field.id === slot.property && (!slot.key || field.slotKey)))
  )
    return candidateFailure(400);
  return {
    ...result,
    descriptor: exact.descriptor,
    fields,
    names: Object.fromEntries(Object.entries(exact.descriptor.properties).map(([id, value]) => [id, value.labels])),
  };
}

export async function proposeRelation(
  client: KernelClient,
  authorization: string,
  descriptor: RelationTypeDescriptorReader,
  input: RelationProposal,
): Promise<RelationProposalResult> {
  if (!input.retry) {
    const current = await readRelationEditor(client, authorization, descriptor, input.id, 'en', input.slot);
    if (!current.ok) return current;
    if (!current.descriptor) return candidateFailure(503);
    const field = current.fields.find((field) => field.id === input.slot.property);
    const statement = statementInput(input.statement);
    if (
      !field ||
      !relationSlotMatches(input.statement, input.slot, field) ||
      checkStatementInput(statement, current.descriptor, { allowUnknownReferences: true }).violations.length
    )
      return candidateFailure(400);
  }
  try {
    const statement = statementInput(input.statement);
    const result = await client.subjects({ id: input.id }).candidates.post(
      { statement },
      {
        headers: { authorization, 'idempotency-key': input.key } as { 'idempotency-key': string },
      },
    );
    const session = new Headers(result.headers).get('rezics-session-token');
    return result.status === 201 && result.data
      ? { ok: true, candidate: result.data.candidate, ...(session ? { session } : {}) }
      : result.status >= 500 || result.status === 201
        ? { ...candidateFailure(result.status), retry: true }
        : candidateFailure(result.status);
  } catch {
    return { ...candidateFailure(503), retry: true };
  }
}

/** Both decision and adoption keep their own heads; only the addressed slot is replaced. */
export async function confirmRelation(
  client: KernelClient,
  authorization: string,
  input: RelationConfirmation,
): Promise<RelationResult> {
  const current = await readCandidates(
    client,
    authorization,
    input.id,
    input.slot.property,
    input.cursor,
    input.slot,
    input.session,
  );
  if (!current.ok) return current;
  const candidate = current.page?.candidates.find((candidate) => candidate.id === input.candidate);
  if (!candidate || candidate.retracted !== null) return candidateFailure(400);
  if (
    input.operation === 'adopt' &&
    (candidate.decision !== 'accepted' ||
      candidate.rank === 'deprecated' ||
      (input.rank !== undefined && input.rank !== 'normal' && input.rank !== 'preferred'))
  )
    return candidateFailure(400);
  if (input.operation === 'reject') {
    try {
      const endpoint = client.subjects({ id: input.id });
      const result = await endpoint
        .candidates({ candidate: input.candidate })
        .$reject.post(
          { context: candidateContext, expected_head: input.head },
          { headers: { authorization, 'idempotency-key': input.key } as { 'idempotency-key': string } },
        );
      if (result.status !== 200 || !result.data) return candidateFailure(result.status);
      let publicRead: SubjectRead | null = null;
      try {
        const session = new Headers(result.headers).get('rezics-session-token');
        const read = await endpoint.get({
          headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
        });
        if (read.status === 200 && read.data?.subject.id === input.id && read.data.subject.context === candidateContext)
          publicRead = read.data;
      } catch {
        /* Read remains unavailable. */
      }
      return { ok: true, kind: 'rejected', public: publicRead };
    } catch {
      return candidateFailure(503);
    }
  }
  const result = await selectCandidate(client, authorization, {
    ...input,
    operation: input.operation,
    property: input.slot.property,
  });
  if (
    result.ok &&
    result.public &&
    (result.public.subject.id !== input.id || result.public.subject.context !== candidateContext)
  )
    return { ...result, public: null, kind: input.operation === 'accept' ? 'accepted' : 'pending' };
  if (
    result.ok &&
    result.kind === 'selected' &&
    !result.public?.subject.statements[input.slot.property]?.some(
      (statement) => statement.id === candidate.id && statement.rank !== 'deprecated',
    )
  )
    return { ...result, kind: input.operation === 'accept' ? 'accepted' : 'pending' };
  return result;
}
