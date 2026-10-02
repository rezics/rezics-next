import { describe, expect, test } from 'bun:test';
import type { AgentOption } from '../features/auth/acting-identity.ts';
import { resolveStudioAgent, studioHref } from '../features/studio/agent.ts';
import { DraftAutosave, type SaveOutcome } from '../features/studio/autosave.ts';
import { diffParagraphs } from '../features/studio/diff.ts';
import {
  type DraftStorage,
  localDraftKey,
  readLocalDraft,
  restoreDecision,
  writeLocalDraft,
} from '../features/studio/local-draft.ts';
import {
  readChapterRevision,
  saveChapterDraft,
  saveOutcomeOf,
} from '../features/studio/content-api.ts';
import { readTextRevision, saveText } from '../features/studio/text-api.ts';
import { agents, ids, storyMain } from '../features/studio/fixtures.ts';
import { fromPlainText, parseStoredDocument, serializeDocument } from '@rezics/document';
import { bodyText } from '../features/document-editor/body.ts';

const head = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An autosave with a scripted Main: each save takes the next outcome and records what was sent. */
function harness(
  outcomes: SaveOutcome[],
  start: { head: string | null; body: string } = { head: head(1), body: 'One' },
) {
  const sent: Array<{ body: string; head: string | null; key: string }> = [];
  const kept: Array<{ body: string; base: string | null } | null> = [];
  let keys = 0;
  const autosave = new DraftAutosave({
    ...start,
    delay: 5,
    save: async (body, expectedHead, key) => {
      sent.push({ body, head: expectedHead, key });
      return outcomes.shift()!;
    },
    keep: (body, base) => kept.push({ body, base }),
    release: () => kept.push(null),
    newKey: () => `key-${++keys}`,
    now: () => new Date('2026-09-28T12:00:00Z'),
  });
  return { autosave, sent, kept };
}

describe('Studio autosave', () => {
  test('typing is kept on the device at once and saved on the current head after a pause', async () => {
    const { autosave, sent, kept } = harness([{ kind: 'saved', head: head(2) }]);
    autosave.edit('One\nTwo');
    expect(autosave.snapshot.state).toBe('unsaved');
    expect(kept).toEqual([{ body: 'One\nTwo', base: head(1) }]);
    await autosave.flush();
    expect(sent).toEqual([{ body: 'One\nTwo', head: head(1), key: 'key-1' }]);
    expect(autosave.snapshot).toMatchObject({ state: 'saved', head: head(2), saved: 'One\nTwo' });
    expect(kept.at(-1)).toBeNull();
    autosave.dispose();
  });

  test('offline keeps the text and replays the unanswered save before sending newer text', async () => {
    const { autosave, sent } = harness([
      { kind: 'offline' },
      { kind: 'offline' },
      { kind: 'saved', head: head(2) },
      { kind: 'saved', head: head(3) },
    ]);
    autosave.edit('One\nTwo');
    await autosave.flush();
    expect(autosave.snapshot.state).toBe('offline');
    await autosave.flush();
    autosave.edit('One\nTwo\nThree');
    expect(autosave.snapshot.state).toBe('offline');
    await autosave.flush();
    // The lost save may have landed: its replay (same key) answers with its head before the new text goes.
    expect(sent).toEqual([1, 2, 3].map(() => ({ body: 'One\nTwo', head: head(1), key: 'key-1' })));
    expect(autosave.snapshot).toMatchObject({ state: 'unsaved', head: head(2), saved: 'One\nTwo' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.at(-1)).toEqual({ body: 'One\nTwo\nThree', head: head(2), key: 'key-2' });
    expect(autosave.snapshot).toMatchObject({ state: 'saved', head: head(3) });
    autosave.dispose();
  });

  test('a pending answer (202) is retried with the same text and key', async () => {
    const { autosave, sent } = harness([
      { kind: 'failed', retryable: true },
      { kind: 'saved', head: head(2) },
    ]);
    autosave.edit('Two');
    await autosave.flush();
    expect(autosave.snapshot.state).toBe('error');
    autosave.edit('Two, then three');
    await autosave.flush();
    expect(sent.map((item) => [item.body, item.key])).toEqual([
      ['Two', 'key-1'],
      ['Two', 'key-1'],
    ]);
    autosave.dispose();
  });

  test('a moved head stops autosave until the writer keeps theirs or mine', async () => {
    const { autosave, sent } = harness([{ kind: 'conflict' }, { kind: 'saved', head: head(4) }]);
    autosave.edit('Mine');
    await autosave.flush();
    expect(autosave.snapshot.state).toBe('conflict');
    autosave.edit('Mine, edited');
    await autosave.flush();
    expect(sent).toHaveLength(1);
    autosave.keepMine(head(3));
    await tick();
    expect(sent.at(-1)).toEqual({ body: 'Mine, edited', head: head(3), key: 'key-2' });
    expect(autosave.snapshot).toMatchObject({ state: 'saved', head: head(4) });
    autosave.dispose();
  });

  test('a conflict keeps the head Main named as the one that won', async () => {
    const { autosave } = harness([{ kind: 'conflict', head: head(5) }]);
    autosave.edit('Mine');
    await autosave.flush();
    expect(autosave.snapshot).toMatchObject({ state: 'conflict', theirs: head(5) });
    autosave.takeTheirs(head(5), 'Theirs');
    expect(autosave.snapshot.theirs).toBeNull();
    autosave.dispose();
  });

  test('taking theirs replaces the editor text and drops the device copy', async () => {
    const { autosave, kept } = harness([{ kind: 'conflict' }]);
    autosave.edit('Mine');
    await autosave.flush();
    autosave.takeTheirs(head(3), 'Theirs');
    expect(autosave.text).toBe('Theirs');
    expect(autosave.snapshot).toMatchObject({ state: 'saved', head: head(3), saved: 'Theirs' });
    expect(kept.at(-1)).toBeNull();
    autosave.dispose();
  });

  test('a denied Agent is not retried', async () => {
    const { autosave, sent } = harness([{ kind: 'denied' }]);
    autosave.edit('Two');
    await autosave.flush();
    autosave.edit('Three');
    await autosave.flush();
    expect(sent).toHaveLength(1);
    expect(autosave.snapshot).toMatchObject({ state: 'error', denied: true });
    autosave.dispose();
  });

  test('text typed during a save is saved next on the new head', async () => {
    let release!: (outcome: SaveOutcome) => void;
    const sent: Array<{ body: string; head: string | null }> = [];
    const autosave = new DraftAutosave({
      head: null,
      body: '',
      delay: 1,
      save: (body, expectedHead) => {
        sent.push({ body, head: expectedHead });
        return sent.length === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ kind: 'saved', head: head(9) });
      },
      keep: () => undefined,
      release: () => undefined,
    });
    const first = autosave.flush();
    autosave.edit('A');
    const saving = autosave.flush();
    autosave.edit('AB');
    await tick();
    release({ kind: 'saved', head: head(8) });
    await Promise.all([first, saving]);
    expect(autosave.snapshot).toMatchObject({ state: 'unsaved', head: head(8), saved: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([
      { body: 'A', head: null },
      { body: 'AB', head: head(8) },
    ]);
    expect(autosave.snapshot.state).toBe('saved');
    autosave.dispose();
  });
});

describe('Studio device drafts', () => {
  const memory = (): DraftStorage => {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
  };

  test('legacy authored JSON stays literal while tagged document drafts retain formatting', () => {
    const storage = memory();
    const snapshot = serializeDocument(fromPlainText('A document'));
    storage.setItem('legacy', JSON.stringify({ body: snapshot, base: null, changedAt: '' }));
    expect(bodyText(readLocalDraft(storage, 'legacy')!.body)).toBe(snapshot);
    writeLocalDraft(storage, 'structured', { body: snapshot, base: null, changedAt: '' });
    expect(readLocalDraft(storage, 'structured')!.body).toBe(snapshot);
  });

  test('each Agent and text has its own key, and malformed copies are ignored', () => {
    const storage = memory();
    const agent = `https://rezics.com/id/${head(1)}`;
    const key = localDraftKey(
      agent,
      `https://rezics.com/id/${head(2)}`,
      `urn:rezics:variant:${head(3)}`,
    );
    expect(key).not.toBe(
      localDraftKey(
        `https://rezics.com/id/${head(4)}`,
        `https://rezics.com/id/${head(2)}`,
        `urn:rezics:variant:${head(3)}`,
      ),
    );
    expect(
      writeLocalDraft(storage, key, {
        body: 'Text',
        base: head(5),
        changedAt: '2026-09-28T12:00:00Z',
      }),
    ).toBe(true);
    expect(readLocalDraft(storage, key)).toEqual({
      body: 'Text',
      base: head(5),
      changedAt: '2026-09-28T12:00:00Z',
    });
    storage.setItem(key, '{"body":1}');
    expect(readLocalDraft(storage, key)).toBeNull();
    expect(writeLocalDraft(null, key, { body: 'Text', base: null, changedAt: '' })).toBe(false);
  });

  test('a device copy on the same head is restored; on a moved head it is a conflict', () => {
    const local = { body: 'Mine', base: head(1), changedAt: '2026-09-28T12:00:00Z' };
    expect(restoreDecision({ head: head(1), body: 'Saved' }, null)).toEqual({ kind: 'server' });
    expect(restoreDecision({ head: head(1), body: 'Mine' }, local)).toEqual({ kind: 'server' });
    expect(restoreDecision({ head: head(1), body: 'Saved' }, local)).toEqual({
      kind: 'restore',
      body: 'Mine',
    });
    expect(restoreDecision({ head: head(2), body: 'Theirs' }, local)).toEqual({
      kind: 'conflict',
      mine: 'Mine',
    });
  });
});

describe('Studio paragraph comparison', () => {
  test('keeps shared paragraphs and marks each side', () => {
    expect(diffParagraphs('A\nB\nC', 'A\nX\nC')).toEqual([
      { kind: 'both', lines: ['A'] },
      { kind: 'mine', lines: ['B'] },
      { kind: 'theirs', lines: ['X'] },
      { kind: 'both', lines: ['C'] },
    ]);
    expect(diffParagraphs('A\nB', 'A\nB')).toEqual([{ kind: 'both', lines: ['A', 'B'] }]);
    expect(diffParagraphs('第一段\n第二段', '第一段\n新的一段\n第二段')).toEqual([
      { kind: 'both', lines: ['第一段'] },
      { kind: 'theirs', lines: ['新的一段'] },
      { kind: 'both', lines: ['第二段'] },
    ]);
  });

  test('an oversized middle is shown as one replaced block', () => {
    const mine = Array.from({ length: 2100 }, (_, index) => `m${index}`).join('\n');
    const theirs = Array.from({ length: 2100 }, (_, index) => `t${index}`).join('\n');
    const runs = diffParagraphs(`same\n${mine}`, `same\n${theirs}`);
    expect(runs.map((run) => [run.kind, run.lines.length])).toEqual([
      ['both', 1],
      ['mine', 2100],
      ['theirs', 2100],
    ]);
  });
});

describe('Studio Agent addresses', () => {
  const agents: AgentOption[] = [
    {
      iri: `https://rezics.com/id/${head(1)}`,
      label: 'Lin Mei',
      handle: null,
      kind: 'person',
      path: 'represented-agent',
    },
    {
      iri: `https://rezics.com/id/${head(2)}`,
      label: 'Moonlit Scribe',
      handle: 'moonlit',
      kind: 'pen-name',
      path: 'represented-agent',
    },
  ];

  test('an Agent is addressed by its handle, or by Main’s agent-<uuid> handle while it has none', () => {
    expect(studioHref(agents[0]!)).toBe(`/studio/@agent-${head(1)}`);
    expect(studioHref(agents[1]!, '/new')).toBe('/studio/@moonlit/new');
  });

  test('the route segment resolves only to this person’s Agents and is never replaced', () => {
    for (const segment of [
      `@agent-${head(1)}`,
      `%40agent-${head(1)}`,
      `@${head(1)}`,
      `@AGENT-${head(1).toUpperCase()}`,
    ]) {
      expect(resolveStudioAgent(segment, agents)).toEqual({ kind: 'agent', agent: agents[0] });
    }
    expect(resolveStudioAgent('@moonlit', agents)).toEqual({ kind: 'agent', agent: agents[1] });
    expect(resolveStudioAgent(`@agent-${head(9)}`, agents)).toEqual({
      kind: 'foreign',
      slug: `agent-${head(9)}`,
    });
    expect(resolveStudioAgent('@someone', [])).toEqual({ kind: 'foreign', slug: 'someone' });
    for (const segment of ['moonlit', '@', '@../x', '%E0%A4%A', `@${'a'.repeat(90)}`]) {
      expect(resolveStudioAgent(segment, agents)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('Studio save outcomes', () => {
  test('Main’s answers map to what autosave does next', () => {
    // A stale head names the head that won, so the editor reads that exact version to compare.
    expect(
      saveOutcomeOf({ status: 409, value: { code: 'stale_head', currentHead: head(7) } }),
    ).toEqual({ kind: 'conflict', head: head(7) });
    expect(saveOutcomeOf({ status: 409, value: { code: 'stale_head' } })).toEqual({
      kind: 'conflict',
      head: null,
    });
    expect(saveOutcomeOf({ status: 409, value: { code: 'idempotency_conflict' } })).toEqual({
      kind: 'failed',
      retryable: false,
    });
    expect(saveOutcomeOf({ status: 403, value: { code: 'authority_denied' } })).toEqual({
      kind: 'denied',
    });
    expect(saveOutcomeOf({ status: 503 })).toEqual({ kind: 'failed', retryable: true });
    expect(saveOutcomeOf({ status: 400 })).toEqual({ kind: 'failed', retryable: false });
    expect(saveOutcomeOf({ status: Number.NaN })).toEqual({ kind: 'offline' });
  });
});

test('Studio text and chapter API adapters preserve formatted snapshots across exact revision reads', async () => {
  const fixture = storyMain({ delayMs: 0 });
  const document = fromPlainText('漢字', 'blocks');
  document.doc.content![0]!.content = [
    {
      type: 'ruby',
      attrs: { rt: 'ㄏㄢˋ', position: 'inter-character' },
      content: [{ type: 'text', text: '漢' }],
    },
    { type: 'text', text: '字', marks: [{ type: 'bold' }] },
  ];
  const body = serializeDocument(document);
  let text = '';
  const saved = await saveText(
    { actingSubject: agents[0]!.iri, work: ids.story, language: 'zh-Hant' },
    null,
    body,
    null,
    'text',
    (created) => {
      text = created;
    },
    fixture.main,
  );
  expect(saved.kind).toBe('saved');
  if (saved.kind !== 'saved') throw new Error('Text did not save');
  expect(
    parseStoredDocument((await readTextRevision(agents[0]!.iri, text, saved.head, fixture.main))!),
  ).toEqual(parseStoredDocument(body));
  const draft = await fixture.main.v1
    .contributions({ contribution: text.slice(-36) })
    .drafts({ revision: saved.head.slice(-36) })
    .get({ query: { actingSubject: agents[0]!.iri } });
  expect(draft.data?.body).toBe('漢字');
  expect(draft.data?.document).toEqual(parseStoredDocument(body) ?? undefined);

  const chapter = await saveChapterDraft(
    {
      actingSubject: agents[0]!.iri,
      chapter: ids.chapters[0]!,
      variant: `urn:rezics:variant:${head(7)}`,
      language: 'zh-Hant',
      direction: 'ltr',
    },
    body,
    null,
    'chapter',
    () => undefined,
    fixture.main,
  );
  expect(chapter.kind).toBe('saved');
  if (chapter.kind !== 'saved') throw new Error('Chapter did not save');
  expect(
    parseStoredDocument(
      (await readChapterRevision(agents[0]!.iri, chapter.head, fixture.main))!.body,
    ),
  ).toEqual(parseStoredDocument(body));
});
