import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  admitted,
  personalSnapshot,
  quotedKey,
  savePersonalOriginal,
  withIdentityHttp,
} from './support/identity-operations-http.ts';

test(
  'merge admission through durable canonical readback completes proposal, acceptance, adoption and independent public readback',
  () =>
    withIdentityHttp(async (d) => {
      await d.grant('editor', ['subject:batch_write'], d.globalContext);
      const routeKey = Buffer.from(d.fixtures.runtime.routeKey, 'base64url');
      const number = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      const bangumi = { source: 'bangumi_cross_media' as const, externalId: `person:${number}` };
      const home = partitionOf(tupleRoute(routeKey, bangumi.source, bangumi.externalId));
      let vndbId = '';
      for (let index = 1; index <= 100_000; index++) {
        const externalId = `s${number}${index}`;
        if (partitionOf(tupleRoute(routeKey, 'vndb_cross_media', externalId)) === home) {
          vndbId = externalId;
          break;
        }
      }
      expect(vndbId).not.toBe('');
      const claims = [
        { source: bangumi.source, externalId: bangumi.externalId, property: 'wdt:P6298' as const, value: number },
        { source: 'vndb_cross_media' as const, externalId: vndbId, property: 'wdt:P3180' as const, value: vndbId },
      ];
      const created = await d.request(
        'editor',
        'POST',
        '/v1/subjects:batchWrite',
        {
          commands: claims.map((claim) => ({
            op: 'create',
            key: randomUUID(),
            source: {
              source: claim.source,
              external_id: claim.externalId,
              record_revision: '1',
              digest: 'c'.repeat(64),
              converter_revision: 'review@1',
              field_group: 'facts',
            },
            subject: {
              type: 'schema:Person',
              labels: { en: `Journey ${claim.source}` },
              statements: {
                [claim.property]: [
                  { property: { id: claim.property }, value: { type: 'value', content: claim.value } },
                ],
              },
            },
          })),
        },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect((created.body.results as { status: number }[]).map((row) => row.status)).toEqual([201, 201]);
      const subjects = (created.body.results as { value: { id: string } }[]).map((row) => row.value.id) as [
        string,
        string,
      ];
      const proposal = await d.request(
        'editor',
        'POST',
        `/v1/subjects/${subjects[0]}/candidates`,
        {
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://www.aozora.gr.jp/' },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://www.aozora.gr.jp/' } },
                ],
              },
            ],
          },
        },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
      const accepted = await d.request(
        'acceptor',
        'POST',
        `/v1/subjects/${subjects[0]}/candidates/${proposal.body.candidate}:accept`,
        { context: GLOBAL_CONTEXT, expected_head: null },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await d.request(
        'acceptor',
        'POST',
        `/v1/subjects/${subjects[0]}:adopt`,
        {
          context: GLOBAL_CONTEXT,
          property: 'schema:url',
          mode: 'replace',
          selection: [{ candidate: proposal.body.candidate, rank: 'preferred' }],
          expected_head: null,
        },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
      const reads = await Promise.all(
        subjects.map((id, index) =>
          d.request(
            'acceptor',
            'GET',
            `/v1/subjects/${id}?${new URLSearchParams({
              reviewIdentitySource: claims[index]!.source,
              reviewIdentityExternalId: claims[index]!.externalId,
              includeViewerActions: 'true',
            })}`,
          ),
        ),
      );
      expect(reads.map((read) => read.status)).toEqual([200, 200]);
      const endpoints = reads.map((read) => read.body.reviewedIdentity);
      expect(endpoints.every((endpoint) => endpoint && endpoint.claimTransactionId)).toBe(true);
      const stored = await savePersonalOriginal(d, subjects[1]!);
      const key = quotedKey();
      const first = await d.request(
        'acceptor',
        'POST',
        '/v1/subjects:merge',
        { subjects, expectedIdentity: { endpoints } },
        { 'Idempotency-Key': key },
      );
      const operation = admitted(first);
      expect(
        admitted(
          await d.request(
            'acceptor',
            'POST',
            '/v1/subjects:merge',
            { subjects, expectedIdentity: { endpoints } },
            { 'Idempotency-Key': key },
          ),
        ),
      ).toEqual(operation);
      const poll = await d.request('acceptor', 'GET', operation.location);
      expect(poll.status).toBe(200);
      expect(poll.body).toEqual({ operation: { id: operation.id, done: false } });
      expect((await d.request('anonymous', 'GET', operation.location)).status).toBe(401);
      expect((await d.request('editor', 'GET', operation.location)).status).toBe(404);
      const [, redirected] = [...subjects].sort();
      const hop = await d.request('anonymous', 'GET', `/v1/subjects/${redirected}`);
      expect(hop.status).toBe(308);
      expect(hop.body.redirect.from).toBe(redirected);
      const survivor = hop.body.redirect.to as string;
      expect(subjects.includes(survivor)).toBe(true);
      expect(routeOf(survivor)).not.toBeNull();
      const publicRead = await d.request('anonymous', 'GET', `/v1/subjects/${survivor}`);
      expect(publicRead.status).toBe(200);
      expect(publicRead.body.subject.id).toBe(survivor);
      expect(publicRead.body.subject.type).toBe('schema:Person');
      expect((await d.request('editor', 'GET', `/v1/subjects/${survivor}`)).status).toBe(200);
      expect(await personalSnapshot(d)).toEqual(stored);
    }),
  180_000,
);
