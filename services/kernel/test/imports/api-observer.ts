import { randomUUID } from 'node:crypto';
import type { BatchWriteResult, Rights, Source as SourceEnvelope } from '@rezics/definitions/bulk';
import { parseDocument, serializeDocument } from '@rezics/document';
import type { ImportApiDriver, Proposal, RecordView, Effects, Source } from '../../../../specs/imports-api-driver.ts';
import type { Json, Statement, Subject, HttpResponse } from '../../../../specs/semantic-driver.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { identitySupport } from './identity-fixture.ts';
import type { ApiRuntime } from './api-runtime.ts';

type Candidate =
  | { id: string; deleted: true }
  | {
      id: string;
      statement: Statement;
      revision: number;
      source: SourceEnvelope | null;
      retracted: number | null;
      retraction: { source: SourceEnvelope; references: Proposal['references'] } | null;
    };
function hasStatement(candidate: Candidate): candidate is Extract<Candidate, { statement: Statement }> {
  return 'statement' in candidate;
}
const envelope = (source: SourceEnvelope) => ({
  source: source.source as Source,
  externalId: source.external_id,
  recordRevision: source.record_revision,
  recordDigest: source.digest,
  converterRevision: source.converter_revision,
  fieldGroup: source.field_group,
});

/**
 * Independent reads of public evidence and route-leading native committed rows. The reviewed-merge case also
 * grants the merge and its gate, which the governance role holds on Global, so it consents to those actions.
 */
export async function openApiObserver(runtime: ApiRuntime, options: { reviewedMerge?: true } = {}) {
  const { identity, database } = runtime;
  const support = identitySupport(identity);
  const scopes = [
    'subject:read',
    'context:read',
    'media:read',
    'statement:propose',
    'context:create',
    'context:accept',
    'context:adopt',
    'access:grant',
    'source_fence:takedown',
    'moderation:takedown',
    ...(options.reviewedMerge ? ['subject:merge', 'gate:subject_identity', 'gate:any'] : []),
  ];
  const clientId = `import-observer-${randomUUID()}`;
  await identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
  // These are the existing identity fixture's ordinary password credentials.
  // /signin and /token, rather than a verifier override, issue this separate observer credential.
  const signed = await support.request('/signin', {
    email: 'governance@identity.test',
    password: 'private native identity fixture password',
    client_id: clientId,
    scope: scopes,
  });
  if (signed.status !== 200) throw new Error(`Observer signin: HTTP ${signed.status}`);
  const token = await support.request(
    '/token',
    {},
    new Headers({
      cookie: signed.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    }),
  );
  if (token.status !== 200) throw new Error(`Observer token: HTTP ${token.status}`);
  const bearer = ((await token.json()) as { access_token: string }).access_token;
  const contexts = new Map<string, string>();
  async function http(path: string, body?: unknown): Promise<HttpResponse> {
    const response = await runtime.request(path, body, bearer);
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as HttpResponse['body'],
    };
  }
  async function required(path: string, body?: unknown, expected = 200) {
    const response = await http(path, body);
    if (response.status !== expected) throw new Error(`Public observer ${path}: HTTP ${response.status}`);
    return response.body;
  }
  async function grant(resource: { route: number; id: string }, actions: string[]) {
    await required(
      '/v1/grants',
      { resource, subject: { kind: 'account', id: identity.governance.accountId }, actions, valid: '(,)' },
      201,
    );
  }
  // Context creation has no standing grant. The deployment's actual governance
  // role administers the explicit parent grant, through the ordinary public API.
  await grant({ route: 0, id: '00000000-0000-8000-8000-000000000000' }, ['context:create']);

  function subject(source: string, externalId: string) {
    const binding = runtime.importer.session.bindings.claim({ source, external_id: externalId });
    return binding?.state === 'bound' ? binding.subject : null;
  }
  async function read(source: string, externalId: string): Promise<RecordView> {
    const id = subject(source, externalId);
    const view: RecordView = { responses: [], subject: null, proposals: [], retracted: [], revisions: [], adopted: {} };
    if (!id) return view;
    const context = contexts.get(id);
    const response = await http(`/v1/subjects/${id}${context ? `?context=${context}` : ''}`);
    view.responses.push(response);
    if (response.status !== 200) return view;
    view.subject = response.body.subject as Subject;
    if (!view.subject) throw new Error('Public subject response lacks subject');
    const properties = new Set(Object.keys(view.subject.statements));
    // The subject view may leave imported candidates unresolved. Independently
    // enumerate native property keys only within this exact subject partition.
    const nativeProperties = await database.admin.query<{ property: string }>(
      'SELECT property FROM semantic.candidate WHERE route=$1 AND subject_id=$2 GROUP BY property ORDER BY property LIMIT 100',
      [routeOf(id), id],
    );
    for (const row of nativeProperties.rows) properties.add(row.property);
    const originalRevisions = new Map<string, number>();
    for (const property of properties) {
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({
          property,
          limit: '100',
          ...(context ? { context } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const page = await http(`/v1/subjects/${id}/candidates?${query}`);
        view.responses.push(page);
        if (page.status !== 200) throw new Error(`Candidate disclosure: HTTP ${page.status}`);
        for (const candidate of page.body.candidates as Candidate[]) {
          if ('deleted' in candidate) continue;
          if (!candidate.source) continue;
          originalRevisions.set(candidate.id, candidate.revision);
          view.proposals.push({
            id: candidate.id,
            subjectId: id,
            ...envelope(candidate.source),
            kind: 'value',
            statement: candidate.statement,
            references: candidate.statement.references ?? [],
          });
          if (candidate.retracted !== null) view.retracted.push(candidate.id);
          if (candidate.retraction) {
            if (candidate.retraction.references.length)
              view.proposals.push({
                id: candidate.id,
                subjectId: id,
                ...envelope(candidate.retraction.source),
                kind: 'source-removal',
                statement: null,
                references: candidate.retraction.references,
              });
          }
        }
        cursor = page.body.next as string | null;
      } while (cursor);
    }
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
      const page = await http(`/v1/subjects/${id}/revisions?${query}`);
      view.responses.push(page);
      if (page.status !== 200) throw new Error(`Revision disclosure: HTTP ${page.status}`);
      for (const revision of page.body.revisions as { revision: number }[])
        view.revisions.push({
          revision: revision.revision,
          proposalIds: [...originalRevisions]
            .filter(([, n]) => n === revision.revision)
            .map(([candidate]) => candidate),
        });
      cursor = page.body.next as string | null;
    } while (cursor);
    if (context)
      for (const [property, statements] of Object.entries(view.subject.statements)) {
        const value = statements[0]?.value.content;
        if (value !== undefined)
          view.adopted[property] =
            property === 'schema:name' && value && typeof value === 'object' && !Array.isArray(value)
              ? value.text!
              : value;
      }
    return view;
  }

  async function effects(): Promise<Effects> {
    const ids = new Set<string>();
    const receipts = new Set<string>();
    for (const captured of runtime.captures) {
      if (new URL(captured.request.url).pathname !== '/v1/subjects:batchWrite' || captured.response.status !== 200)
        continue;
      const result = (await captured.response.clone().json()) as BatchWriteResult;
      for (const entry of result.results) {
        const known = runtime.commands.get(entry.key);
        if (!known || !('value' in entry)) continue;
        const identity = await runtime.receipt(entry.key);
        if (identity) receipts.add(identity);
        if (known.command.op === 'create' && 'id' in entry.value) ids.add(entry.value.id);
        else if (known.command.op !== 'create') ids.add(known.command.subject);
      }
    }
    const result: Effects = { subjects: 0, proposals: 0, revisions: 0, receipts: receipts.size };
    for (const id of ids) {
      const rows = await database.admin.query(
        'SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2',
        [routeOf(id), id],
      );
      result.subjects += rows.rowCount ?? 0;
      let after = 0;
      for (;;) {
        const revisions = await database.admin.query<{ revision: number; kind: string }>(
          'SELECT revision,kind FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision>$3 ORDER BY revision LIMIT 100',
          [routeOf(id), id, after],
        );
        for (const revision of revisions.rows) {
          result.revisions++;
          if (revision.kind === 'propose' || revision.kind === 'retract') result.proposals++;
        }
        if (revisions.rows.length < 100) break;
        after = revisions.rows.at(-1)!.revision;
      }
    }
    return result;
  }

  async function document(proposal: Proposal): ReturnType<ImportApiDriver['document']> {
    const reference = proposal.statement?.value.content as {
      id?: string;
      document?: string;
      digest: string;
      language: string;
    };
    const id = reference.id ?? reference.document;
    if (!id) throw new Error('No native document reference');
    const response = await runtime.request(`/v1/documents/${id}`, undefined, bearer);
    const body = (await response.json()) as { document?: { body: unknown } };
    const native = await database.admin.query<{ body: Buffer; digest: string; rights: Rights; xmin: string }>(
      "SELECT body,encode(body_sha256,'hex') AS digest,rights,xmin::text FROM content.imported_field WHERE route=$1 AND id=$2",
      [routeOf(id), id],
    );
    const semantic = await database.admin.query<{ statement: Statement; xmin: string }>(
      'SELECT statement,xmin::text FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(proposal.subjectId), proposal.subjectId, proposal.id],
    );
    const row = native.rows[0],
      candidate = semantic.rows[0];
    if (!row || !candidate) throw new Error('Unbound native document');
    const actual = candidate.statement.value.content as typeof reference;
    return {
      response: {
        status: response.status,
        headers: response.headers,
        bytes: body.document
          ? new TextEncoder().encode(serializeDocument(parseDocument(body.document.body)))
          : new Uint8Array(),
      },
      stored: { id, digest: row.digest, bytes: new Uint8Array(row.body), rights: row.rights, transactionId: row.xmin },
      semantic: {
        documentId: actual.id ?? actual.document!,
        digest: actual.digest,
        language: actual.language,
        body: null,
        transactionId: candidate.xmin,
      },
    };
  }

  async function disclose(proposal: Proposal) {
    if (proposal.fieldGroup === 'summary') {
      const reference = proposal.statement?.value.content as { id?: string; document?: string };
      const response = await runtime.request(`/v1/documents/${reference.id ?? reference.document}`, undefined, bearer);
      return {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    }
    const id = String(proposal.statement?.value.content);
    const native = await runtime.mediaBoundary.observe(id);
    const variant = native.variants[0];
    const response = await runtime.request(
      `/v1/media/${id}:authorizeDownload?variant=${variant ? `${variant.format}-${variant.width}` : 'webp-48'}`,
      undefined,
      bearer,
    );
    const body = (await response.json()) as { allowed?: boolean; key?: string };
    return {
      status: response.status,
      headers: response.headers,
      bytes:
        body.allowed && body.key
          ? ((await runtime.mediaBoundary.configuration.storage.get(body.key)) ?? new Uint8Array())
          : new Uint8Array(),
    };
  }

  async function adoptSubject(id: string, property: string, value: Json, selectedContext?: string) {
    let context = selectedContext ?? contexts.get(id);
    if (!context) {
      context = (
        (await required('/v1/contexts', { labels: { en: 'Community catalogue' } }, 201)).context as { id: string }
      ).id;
      contexts.set(id, context);
    }
    const listing = await required(
      `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
    );
    const current = (listing.candidates as Candidate[]).filter(hasStatement);
    let candidate = current.find(
      (c) =>
        JSON.stringify(c.statement.value.content) === JSON.stringify(value) ||
        (property === 'schema:name' && (c.statement.value.content as { text?: string })?.text === value),
    )?.id;
    if (!candidate) {
      const cited = current.find((c) => c.statement.references.length > 0);
      if (!cited) throw new Error('Manual community proposal requires a retrieved source reference');
      candidate = (
        await required(
          `/v1/subjects/${id}/candidates`,
          {
            statement: {
              property: { id: property },
              value: { type: 'value', content: property === 'schema:name' ? { language: 'en', text: value } : value },
              references: cited.statement.references.map((reference) => ({
                parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
              })),
            },
          },
          201,
        )
      ).candidate as string;
    }
    await required(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null });
    await required(`/v1/subjects/${id}:adopt`, {
      context,
      property,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: (listing.adoption as { head: number } | null)?.head ?? null,
    });
  }

  return {
    read,
    effects,
    document,
    disclose,
    subject,
    http,
    bearer,
    adoptSubject,
    async adopt(source: string, externalId: string, property: string, value: Json) {
      const id = subject(source, externalId);
      if (!id) throw new Error('Missing adoption subject');
      await adoptSubject(id, property, value);
    },
    async takedown(source: string, externalId: string, fieldGroup: string) {
      if (fieldGroup === 'cover') {
        const view = await read(source, externalId);
        const media = view.proposals.find((p) => p.fieldGroup === 'cover' && p.statement)?.statement?.value.content;
        if (typeof media !== 'string') throw new Error('Missing actual media for complaint');
        const key = randomUUID();
        const response = await runtime.request(
          `/v1/media/${media}:takeDown`,
          { reason: 'Rights complaint' },
          bearer,
          key,
        );
        const body = await response.json();
        if (response.status !== 200 || typeof body.securityRevision !== 'string')
          throw new Error(`Public media takedown: HTTP ${response.status} ${JSON.stringify(body)}`);
        const receipt = await database.admin.query<{ transaction_id: string }>(
          `SELECT transaction_id FROM core.receipt
           WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
             AND command_kind='content.media.takedown' AND idempotency_key=$3`,
          [partitionOf(routeOf(media)!), identity.governance.accountId, key],
        );
        if (receipt.rows.length !== 1) throw new Error('Missing native media takedown receipt');
      }
      await required('/v1/sourceFences:takedown', { source, externalId, fieldGroup, reason: 'Rights complaint' });
    },
  };
}
