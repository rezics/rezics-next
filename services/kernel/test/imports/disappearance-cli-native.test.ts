import { expect, test } from 'bun:test';
import { feed, openDisappearanceCli, records } from './disappearance-cli-native-fixture.ts';

test('an operator sees a native mass-disappearance stop with no effects then explicitly reviews the existing threshold and completes only the admitted source removals while communal subjects and immutable receipts survive', async () => {
  const f = await openDisappearanceCli();
  try {
    const initial = await f.invoke(feed());
    expect(initial.code, JSON.stringify(initial)).toBe(0);
    expect(initial.stdout).toBe('Import complete: new=5 changed=0 unchanged=0 vanished=0 skipped=0\n');
    expect(initial.exchanges).toHaveLength(10); // Five minimal creates and five proposal envelopes.
    for (const exchange of initial.exchanges) {
      expect(exchange.status).toBe(200);
      expect(exchange.result.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
      for (const command of exchange.body.commands) {
        expect(command.source.record_revision).toBe('unversioned');
        expect(command.source.field_group).toBe('facts');
      }
    }
    const first = f.inspect();
    expect(first.source.count).toBe(5);
    expect(first.active).toBeNull();
    const ids = first.records.map((row) => {
      expect(row.claim?.state).toBe('bound');
      if (row.claim?.state !== 'bound') throw new Error('Missing native CLI binding');
      expect(row.bootstrap).not.toBeNull();
      expect(row.candidates).toHaveLength(2);
      expect(row.state.baseline?.state).toBe('present');
      expect(row.state.acknowledged).toEqual(row.state.baseline);
      return row.claim.subject;
    });
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect((await f.subject(id)).id).toBe(id);
    const affected = ids[3]!;
    const listing = await f.candidates(affected);
    expect(listing.rows).toHaveLength(1);
    const sourceCandidate = listing.rows[0]!;
    expect(sourceCandidate.source?.external_id).toBe(String(records[3]!.id));
    expect(sourceCandidate.retracted).toBeNull();
    // Separate communal Contexts independently choose a retrieved source fact and an editor's own fact.
    const contexts: string[] = [];
    for (const label of ['Source fact review', 'Independent catalogue']) {
      const response = await f.editor.http('/v1/contexts', { labels: { en: label } });
      expect(response.status).toBe(201);
      contexts.push((response.body.context as { id: string }).id);
    }
    const independent = await f.editor.http(`/v1/subjects/${affected}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Independent community title' } },
        references: sourceCandidate.statement.references.map((reference) => ({
          parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
        })),
      },
    });
    expect(independent.status).toBe(201);
    const independentId = independent.body.candidate as string;
    expect(independentId).not.toBe(sourceCandidate.id);
    for (const [index, candidate] of [sourceCandidate.id, independentId].entries()) {
      const context = contexts[index]!;
      const current = await f.candidates(affected, context);
      expect(current.rows.some((row) => row.id === candidate)).toBe(true);
      expect(
        (
          await f.editor.http(`/v1/subjects/${affected}/candidates/${candidate}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.editor.http(`/v1/subjects/${affected}:adopt`, {
            context,
            property: 'schema:name',
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            expected_head: (current.adoption as { head: number } | null)?.head ?? null,
          })
        ).status,
      ).toBe(200);
    }
    const selected = await Promise.all(contexts.map((context) => f.subject(affected, context)));
    expect(selected[0]!.statements['schema:name']?.[0]?.value).toEqual(sourceCandidate.statement.value);
    expect(selected[1]!.statements['schema:name']?.[0]?.value.content).toEqual({
      language: 'en',
      text: 'Independent community title',
    });
    const adoptions = await Promise.all(
      contexts.map(async (context) => (await f.candidates(affected, context)).adoption),
    );
    const receipts = await f.receipts();
    expect(receipts).toHaveLength(15); // create + external identifier + name for each record.
    const revisions = await f.revisions(ids);
    const originalCandidates = await Promise.all(ids.map((id) => f.candidates(id)));

    // The exact complete supplied successor removes two records. The default 20% guard stops 40% loss.
    const successor = feed(records.slice(0, 3));
    const stopped = await f.invoke(successor);
    expect(stopped.code).toBe(3);
    expect(stopped.stdout).toBe('');
    // No records were reconciled: these are maintained outcome counts, not guessed classifications.
    expect(stopped.stderr).toBe(
      'Disappearance threshold exceeded.\nnew=0 changed=0 unchanged=0 vanished=0 skipped=0\n',
    );
    expect(stopped.exchanges).toEqual([]);
    const stopState = f.inspect();
    expect(stopState.acquisition).toEqual({
      status: 'mass-disappearance',
      threshold: 0.2,
      prior: 5,
      supplied: 3,
      survivors: 3,
      classified: 0,
      resolved: 0,
      prepared: 0,
    });
    expect(stopState.source).toEqual(first.source);
    expect(stopState.active).toBeNull();
    expect(stopState.records).toEqual(first.records);
    expect(await f.receipts()).toEqual(receipts);
    expect(await f.revisions(ids)).toEqual(revisions);
    expect(await Promise.all(ids.map((id) => f.candidates(id)))).toEqual(originalCandidates);

    // Ordinary CLI invocation, same state and bytes, using only the pre-existing scalar option.
    const admitted = await f.invoke(successor, '0.5');
    expect(admitted.code, JSON.stringify(admitted)).toBe(0);
    expect(admitted.stdout).toBe('Import complete: new=0 changed=0 unchanged=3 vanished=2 skipped=0\n');
    const removed = admitted.exchanges.flatMap((exchange) => {
      expect(exchange.status).toBe(200);
      expect(exchange.result.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
      return exchange.body.commands;
    });
    expect(removed).toHaveLength(4);
    expect(new Set(removed.map((command) => command.source.external_id))).toEqual(
      new Set(records.slice(3).map((r) => String(r.id))),
    );
    for (const command of removed) {
      expect(command.op).toBe('retract');
      if (command.op !== 'retract') throw new Error('Unexpected admitted write');
      const prior = first.records.find((row) => row.key === command.source.external_id)!;
      expect(prior.candidates.some((candidate) => candidate.candidate === command.candidate)).toBe(true);
      expect(command.source.digest).toBe(prior.state.baseline!.digest);
      expect(command.source.record_revision).toBe('unversioned');
      expect(command.references.length).toBeGreaterThan(0);
    }
    const reduced = f.inspect();
    expect(reduced.active).toBeNull();
    expect(reduced.source.count).toBe(3);
    expect(reduced.source.generation).not.toBe(first.source.generation);
    expect(reduced.acquisition).toMatchObject({
      status: 'complete',
      threshold: 0.5,
      prior: 5,
      supplied: 3,
      survivors: 3,
      classified: 5,
      resolved: 5,
    });
    for (const [index, row] of reduced.records.entries()) {
      expect(row.claim).toEqual(first.records[index]!.claim);
      expect(row.bootstrap).toEqual(first.records[index]!.bootstrap);
      expect(row.state.baseline?.state).toBe(index < 3 ? 'present' : 'vanished');
      expect(row.candidates).toEqual(index < 3 ? first.records[index]!.candidates : []);
    }
    const afterCandidates = await Promise.all(ids.map((id) => f.candidates(id)));
    for (const index of [0, 1, 2]) expect(afterCandidates[index]).toEqual(originalCandidates[index]);
    for (const index of [3, 4]) {
      const candidate = afterCandidates[index]!.rows.find((row) => row.id === originalCandidates[index]!.rows[0]!.id)!;
      expect(candidate.statement).toEqual(originalCandidates[index]!.rows[0]!.statement);
      expect(candidate.revision).toBe(originalCandidates[index]!.rows[0]!.revision);
      expect(candidate.retracted).not.toBeNull();
      expect(candidate.retraction?.source.external_id).toBe(String(records[index]!.id));
      expect(candidate.retraction?.references.length).toBeGreaterThan(0);
    }
    const ownFact = afterCandidates[3]!.rows.find((row) => row.id === independentId)!;
    expect(ownFact.source).toBeNull();
    expect(ownFact.retracted).toBeNull();
    for (const [index, context] of contexts.entries()) {
      const subject = await f.subject(affected, context);
      expect(subject.id).toBe(affected);
      expect(subject.statements).toEqual(selected[index]!.statements);
      expect((await f.candidates(affected, context)).adoption).toEqual(adoptions[index]);
    }
    const acceptedReceipts = await f.receipts();
    expect(acceptedReceipts).toHaveLength(receipts.length + 4);
    expect(acceptedReceipts.filter((row) => receipts.some((old) => old.key === row.key))).toEqual(receipts);
    const acceptedRevisions = await f.revisions(ids);
    for (const index of [0, 1, 2]) expect(acceptedRevisions[index]).toEqual(revisions[index]);

    const repeated = await f.invoke(successor, '0.5');
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toBe('Import complete: new=0 changed=0 unchanged=3 vanished=0 skipped=0\n');
    expect(repeated.exchanges).toEqual([]);
    expect(f.inspect().source).toEqual(reduced.source);
    expect(f.inspect().records).toEqual(reduced.records);
    expect(await f.receipts()).toEqual(acceptedReceipts);
    expect(await f.revisions(ids)).toEqual(acceptedRevisions);

    // Byte-identical original requests still return immutable success, including vanished bootstraps.
    for (const exchange of initial.exchanges) {
      expect(await exchange.request.clone().text()).toBe(exchange.bytes);
      const replay = await f.runtime.replay(exchange.request.clone());
      expect(replay.status).toBe(exchange.status);
      expect(await replay.text()).toBe(exchange.response);
    }
    await f.native.renewManagement();
    await f.runtime.identity.setBulkPermission(false);
    for (const exchange of initial.exchanges.filter(
      (e) => e.body.commands[0]!.source.external_id === String(records[3]!.id),
    )) {
      const denied = await f.runtime.replay(exchange.request.clone());
      expect(denied.status).toBe(403);
      const bytes = await denied.text();
      expect(bytes).not.toContain(affected);
      expect(bytes).not.toContain(sourceCandidate.id);
      expect(bytes).not.toBe(exchange.response);
    }
    await f.runtime.identity.setBulkPermission(true);
    expect(await f.receipts()).toEqual(acceptedReceipts);

    // Threshold 1 never admits loss of the entire current baseline.
    const empty = await f.invoke('', '1');
    expect(empty.code).toBe(3);
    expect(empty.exchanges).toEqual([]);
    expect(f.inspect().acquisition).toMatchObject({
      status: 'mass-disappearance',
      threshold: 1,
      prior: 3,
      supplied: 0,
      survivors: 0,
      prepared: 0,
    });
    expect(f.inspect().source).toEqual(reduced.source);
    expect(f.inspect().records).toEqual(reduced.records);
    // A valid changed prefix followed by bad framing, or a failed upstream EOF, is never complete input.
    const changedPrefix = feed([{ ...records[0]!, name: 'Uncommitted changed prefix' }]);
    for (const [text, failAtEof] of [
      [changedPrefix + '{malformed}\n', false],
      [changedPrefix + '{"id":', false],
      ['', true],
    ] as const) {
      const invalid = await f.invoke(text, '1', failAtEof);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain('Input is incomplete or invalid.');
      expect(invalid.exchanges).toEqual([]);
      expect(f.inspect().acquisition).toMatchObject({ status: 'invalid-input', threshold: 1, prior: 3, prepared: 0 });
      expect(f.inspect().active).toBeNull();
      expect(f.inspect().source).toEqual(reduced.source);
      expect(f.inspect().records).toEqual(reduced.records);
    }
    expect(await f.receipts()).toEqual(acceptedReceipts);
    expect(await f.revisions(ids)).toEqual(acceptedRevisions);
    expect(await Promise.all(ids.map((id) => f.candidates(id)))).toEqual(afterCandidates);
    for (const id of ids) expect((await f.subject(id)).id).toBe(id);
    expect(f.authPaths.filter((path) => path === '/signin/key').length).toBeGreaterThan(0);
    expect(f.authPaths.filter((path) => path === '/token').length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
}, 600_000);
