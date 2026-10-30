import { expect, test } from 'bun:test';
import { catalogueChangesFixture, changesCursor, changesLastCursor } from '../src/kernel/fake/catalogue-changes';
import { changesState, readSubjectChange, type ChangesState } from '../src/features/catalogue/subject-changes';

// Consumer outcomes through the generated list client and normalized detail port.
// A port example is not evidence that the unpublished producer endpoint is served.
test('a reader follows paginated native subject revisions to a safe change explanation and current reading without inventing historical payload or leaking concealed details', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  expect(first.kind).toBe('ready');
  if (first.kind !== 'ready') throw new Error('Expected revisions');
  const second = await fixture.transport.list(first.page.next!, first.session);
  if (second.kind !== 'ready') throw new Error('Expected continuation');
  const last = await fixture.transport.list(second.page.next!, second.session);
  if (last.kind !== 'ready') throw new Error('Expected last page');
  const selected = last.page.revisions[0]!.revision;
  // The consumer supports metadata-only safe detail without inferring values or selection.
  const detail = await readSubjectChange(
    fixture.client,
    fixture.id,
    selected,
    { session: last.session },
    async (_client, input) => ({
      kind: 'ready',
      detail: {
        id: input.id,
        revision: input.revision,
        summary: { kind: 'limited' },
      },
    }),
  );
  expect(detail).toEqual({ kind: 'ready', detail: { id: fixture.id, revision: 2, summary: { kind: 'limited' } } });
  expect(first.page.href).toContain(`/subjects/${fixture.id}/`);
  expect(first.page.revisions[0]).toEqual({ revision: 5, kind: 'propose' });
  expect(JSON.stringify(first.page)).not.toContain('record_revision');
  expect(JSON.stringify(detail)).not.toContain('statement');
  const listings = fixture.calls.filter((call) => call.path.endsWith('/revisions'));
  expect(listings.map((call) => call.cursor)).toEqual([null, changesCursor, changesLastCursor]);
  expect(listings[1]).toMatchObject({ authorization: 'Bearer story', session: 'changes-session' });
  expect(
    fixture.calls.filter((call) => !call.path.endsWith('/revisions')).every((call) => call.authorization === null),
  ).toBe(true);
  // Until the generated producer DTO is integrated, runtime detail is honestly unavailable.
  expect(await fixture.transport.detail(2)).toEqual({ kind: 'unavailable' });
});

test('an empty continuation with another opaque next keeps the earlier revisions and selection', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  let state: ChangesState = changesState({}, { type: 'list', result: first, more: false });
  state = changesState(state, { type: 'detail-start', revision: 5 });
  state = changesState(state, { type: 'detail', result: { kind: 'unavailable' } });
  const second = await fixture.transport.list(state.page!.next!);
  state = changesState(state, { type: 'list', result: second, more: true });
  expect(state.page?.revisions.map((row) => row.revision)).toEqual([5, 4]);
  expect(state.page?.next).toBe(changesLastCursor);
  expect(state.selected).toBe(5);
  state = changesState(state, { type: 'list', result: { kind: 'unavailable' }, more: true });
  expect(state.page?.next).toBe(changesLastCursor);
  expect(state.failure?.kind).toBe('unavailable');
});

test('failed detail reads keep list and selection but discard prior detail; current subject concealment clears the page', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  const initial = changesState({}, { type: 'list', result: first, more: false });
  for (const kind of ['denied', 'missing', 'invalid', 'conflict', 'unavailable'] as const) {
    let state = changesState(initial, { type: 'detail-start', revision: 5 });
    state = changesState(state, { type: 'detail', result: { kind } });
    expect(state.page).toBe(initial.page);
    expect(state.selected).toBe(5);
    expect(state.detail).toEqual({ kind });
    state = changesState(state, { type: 'detail-start', revision: 5 });
    expect(state.detail).toBeUndefined();
    expect(state.loading).toBe('detail');
  }
  fixture.conceal();
  const detail = await fixture.transport.detail(5);
  expect(detail).toEqual({ kind: 'missing', scope: 'subject' });
  // An independent explanation failure must not mask a current visibility refusal.
  expect(
    await readSubjectChange(fixture.client, fixture.id, 5, {}, async () => {
      throw new Error('Detail transport unavailable');
    }),
  ).toEqual({ kind: 'missing', scope: 'subject' });
  expect(changesState(initial, { type: 'detail', result: detail })).toEqual({ failure: detail });
});
