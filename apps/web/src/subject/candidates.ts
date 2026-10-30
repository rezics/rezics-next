import type { KernelClient, SubjectRead } from '@rezics/client';

type Endpoint = ReturnType<KernelClient['subjects']>;
export type CandidatePage = NonNullable<Awaited<ReturnType<Endpoint['candidates']['get']>>['data']>;
export type Candidate = CandidatePage['candidates'][number];
export type CandidateField = { id: string; label: string };
export type CandidateSlot = { target?: string; sameAs?: string; key?: string };
export type CandidateFailure = { ok: false; reason: 'denied' | 'stale' | 'unavailable' | 'invalid' };
export type CandidateRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      fields: CandidateField[];
      names: Record<string, Record<string, string>>;
      page: CandidatePage | null;
    };
export type CandidateCommand = {
  id: string;
  property: string;
  candidate: string;
  operation: 'accept' | 'adopt';
  head: number | null;
  key: string;
  slot?: CandidateSlot;
  rank?: 'normal' | 'preferred';
};
export type CandidateResult =
  | CandidateFailure
  | {
      ok: true;
      kind: 'accepted' | 'selected' | 'pending';
      public: SubjectRead | null;
    };

export const candidateContext = '00000000-0000-8000-8000-000000000000';

/** Optional producer metadata follows the existing subject Sources region's runtime compatibility read. */
export function candidateSourceRecords(subject: object): {
  name: string;
  url: string;
  attribution?: string;
  licence?: { id: string; url?: string };
}[] {
  const records: unknown = Reflect.get(subject, 'sourceRecords');
  if (!Array.isArray(records)) return [];
  return records.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.url !== 'string') return [];
    const licence = record.licence as { id?: unknown; url?: unknown } | null | undefined;
    return [
      {
        name: record.name,
        url: record.url,
        ...(typeof record.attribution === 'string' ? { attribution: record.attribution } : {}),
        ...(licence && typeof licence.id === 'string'
          ? { licence: { id: licence.id, ...(typeof licence.url === 'string' ? { url: licence.url } : {}) } }
          : {}),
      },
    ];
  });
}

export function candidateFailure(status: number): CandidateFailure {
  // Missing and hidden use the same unavailable outcome. Never reveal existence from a denial.
  return {
    ok: false,
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 409
          ? 'stale'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable',
  };
}

export async function readCandidates(
  client: KernelClient,
  authorization: string,
  id: string,
  property?: string,
  cursor?: string,
  slot?: CandidateSlot,
): Promise<CandidateRead> {
  try {
    if (slot) {
      // A relation comparison needs no per-candidate hydration: use supplied related summaries.
      const [current, result] = await Promise.all([
        client.subjects({ id }).get(),
        client.subjects({ id }).candidates.get({
          query: { property: property!, context: candidateContext, ...slot, limit: 20, ...(cursor ? { cursor } : {}) },
          headers: { authorization },
        }),
      ]);
      if (!current.data || current.status !== 200) return candidateFailure(current.status);
      if (current.data.subject.id !== id || current.data.subject.context !== candidateContext)
        return candidateFailure(400);
      if (!result.data || result.status !== 200) return candidateFailure(result.status);
      return { ok: true, public: current.data, fields: [], names: {}, page: result.data };
    }
    // This ordinary reader intentionally has no viewer authorization or private overlay.
    const current = await client.subjects({ id }).get();
    if (!current.data || current.status !== 200) return candidateFailure(current.status);
    if (!property) return { ok: true, public: current.data, fields: [], names: {}, page: null };
    const result = await client.subjects({ id }).candidates.get({
      query: { property, context: candidateContext, limit: 20, ...(cursor ? { cursor } : {}) },
      headers: { authorization },
    });
    if (!result.data || result.status !== 200) return candidateFailure(result.status);
    // At most one target per returned candidate (20). These are public point reads, never a catalogue scan.
    const targets = new Set(
      result.data.candidates.flatMap(({ statement }) =>
        statement.property.data_type === 'wikibase-item' &&
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string' &&
        !current.data.related[statement.value.content]
          ? [statement.value.content]
          : [],
      ),
    );
    for (const target of targets) {
      const read = await client.subjects({ id: target }).get();
      if (read.status === 200 && read.data)
        current.data.related[target] = {
          labels: read.data.subject.labels,
        } as SubjectRead['related'][string];
    }
    return { ok: true, public: current.data, fields: [], names: {}, page: result.data };
  } catch {
    return candidateFailure(503);
  }
}

export function candidateIsPublic(current: SubjectRead, property: string, candidate: string): boolean {
  return current.subject.statements[property]?.some((statement) => statement.id === candidate) ?? false;
}

/** One confirmed native command, followed by one ordinary public read; never substitute proposal JSON. */
export async function selectCandidate(
  client: KernelClient,
  authorization: string,
  input: CandidateCommand,
): Promise<CandidateResult> {
  try {
    const endpoint = client.subjects({ id: input.id });
    const options = { headers: { authorization, 'idempotency-key': input.key } as { 'idempotency-key': string } };
    const result =
      input.operation === 'accept'
        ? await endpoint
            .candidates({ candidate: input.candidate })
            .$accept.post({ context: candidateContext, expected_head: input.head }, options)
        : await endpoint.$adopt.post(
            {
              context: candidateContext,
              property: input.property,
              ...input.slot,
              mode: 'replace',
              selection: [{ candidate: input.candidate, rank: input.rank ?? 'normal' }],
              expected_head: input.head,
            },
            options,
          );
    if (result.status !== 200 || !result.data) return candidateFailure(result.status);
    let current: SubjectRead | null = null;
    try {
      const read = await endpoint.get();
      if (read.status === 200 && read.data) current = read.data;
    } catch {
      /* A committed command does not prove that the public reader is ready. */
    }
    return {
      ok: true,
      kind:
        current && candidateIsPublic(current, input.property, input.candidate)
          ? 'selected'
          : input.operation === 'accept'
            ? 'accepted'
            : 'pending',
      public: current,
    };
  } catch {
    return candidateFailure(503);
  }
}
