import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const messagesDirectory = join(import.meta.dir, '..', 'messages');

test("every locale's messages have the same keys, sorted by key", () => {
  const files = readdirSync(messagesDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  expect(files).toHaveLength(8);

  const locales = files.map((file) => ({
    locale: file.slice(0, -5),
    messages: JSON.parse(readFileSync(join(messagesDirectory, file), 'utf8')) as Record<string, string>,
  }));
  const expectedKeys = Object.keys(locales[0]!.messages).sort();

  for (const { locale, messages } of locales) {
    const keys = Object.keys(messages);
    expect(keys, `${locale} keys are sorted`).toEqual([...keys].sort());
    expect(keys, `${locale} keys match every other locale`).toEqual(expectedKeys);
  }
});

function document(path: string): string {
  return readFileSync(join(import.meta.dir, '../../..', path), 'utf8')
    .replace(/\s+/g, ' ')
    .trim();
}

test('docs/deletion.md states terminal account erasure and retention without waiting for the restore window', () => {
  const policy = document('docs/deletion.md');
  expect(policy).toContain('## Account erasure');
  expect(policy).toContain(
    'Account erasure is final at confirmation, with fresh authentication and the typed confirmation.',
  );
  expect(policy).toContain('T, is both a read and write fence');
  expect(policy).toContain('Every worker checks the fence before any effect.');
  expect(policy).toContain('one terminal erasure workflow');
  expect(policy).toContain('participant list is fixed and versioned');
  expect(policy).toContain('minimal completion record lives in PostgreSQL outside DBOS history');
  expect(policy).toContain('Cleanup follows every role the account held');
  expect(policy).toContain('exact locators that the producing owner records atomically with the copy');
  expect(policy).toContain('registered minimizer');
  expect(policy).toContain('Private, unlisted and already deleted material is erased, including archived versions.');
  expect(policy).toContain('last completely published generation, never a pending one or a fresh evaluation');
  expect(policy).toContain('Published reading logs are erased.');
  expect(policy).toContain('subset is defined by the payment and tax retention schedule');
  expect(policy).toContain('schedule remains an open external condition');
  expect(policy).toContain('keyset seeks');
  expect(policy).toContain('explicit byte limits');
  expect(policy).toContain('retention exceptions outstanding');
  expect(policy).toContain('backup expiry outstanding');
  expect(policy).toContain('indexed existence probes, never by full counts');
  expect(policy).toContain('it never postpones account erasure');
  expect(policy).not.toContain('purged when the window ends');
  expect(policy).toEndWith(
    "Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.",
  );
});

test('Access callers prepare evidence after any wait and immediately before the applying transaction', () => {
  const access = document('services/kernel/src/access/README.md');
  expect(access).toContain('min(caller deadline, real time + 1 s)');
  expect(access).toContain('prepare evidence immediately before the transaction that applies it');
  expect(access).toContain('never wait between preparing and applying it');
  expect(access).toContain('no freshness or projection wait, lock wait, sleep or retry back-off');
  expect(access).toContain('A caller that must wait does so first and prepares afterwards; a retry prepares afresh.');
  expect(access).toContain('Evidence that elapses before it is applied answers 503 without effects.');
});

test('Access account deletion erases published reading logs and links the erasure protocol', () => {
  const access = document('services/kernel/src/access/README.md');
  const policy = access.split('## Account deletion policy ')[1]!.split('## Retention inventory')[0]!;
  expect(policy).toContain(
    'Active public Collections stay, with their current notes, as frozen, de-identified contributions.',
  );
  expect(policy).toContain('Published reading logs are erased.');
  expect(policy).toContain('erasure protocol, participants and completion');
  expect(policy).toContain('../../../../docs/deletion.md#account-erasure');
  expect(policy).not.toContain('explicitly published log snapshots');
  expect(policy).not.toContain('Retained logs are detached');
  expect(access).toContain('Account erasure starts at T and does not wait for any window.');
  expect(access).not.toContain('bounds private-data purge by the end of the 30-day window');
});

test('Access agent verification follows permanent subject identity and serialized merge and unmerge', () => {
  const access = document('services/kernel/src/access/README.md');
  const verification = access.split('### Account agent verification ')[1]!.split('### Agent verification policy')[0]!;
  expect(verification).toContain('A subject id permanently names a catalogue record and is never reused');
  expect(verification).toContain('merging asserts duplicate identity only');
  expect(verification).toContain('Every published redirect points directly at an active terminal');
  expect(verification).toContain('a read takes at most one step');
  expect(verification).toContain('at most 4,096 originals, checked when a merge is admitted');
  expect(verification).toContain('Stored references are never rewritten');
  expect(verification).toContain('New writes address the current terminal, and canonical views group them.');
  expect(verification).toContain("Merge and unmerge run serialized through Semantic's one durable identity job");
  expect(verification).toContain('marks a catalogue identity epoch pending');
  expect(verification).toContain('bounded mapping and index maintenance, then publishes the next epoch');
  expect(verification).toContain('A crashed job stays pending and resumes.');
  expect(verification).toContain('no stored reference is moved or rewritten');
  expect(verification).not.toContain('links moved from the account node');
});
