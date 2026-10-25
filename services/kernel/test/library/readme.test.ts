import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const kernel = join(dirname(fileURLToPath(import.meta.url)), '../..');
const readmePath = join(kernel, 'src/library/README.md');

const sections = ['## Scope', '## Partitions', '## Privacy', '## Ordering', '## Cost'] as const;

const scopeTerms = [
  'ordered members',
  'library entries',
  'progress sessions',
  'copies',
  'follows',
  'published logs',
  'public subject listing',
  'single follow model',
] as const;

const operations = [
  'Command envelope',
  'Authorization',
  'Create Collection',
  'Update Collection',
  'Delete Collection',
  'Add member',
  'Move member',
  'Note member',
  'Remove member',
  'Collection read',
  'Curator list',
  'Members page',
  'Subject page',
  'Entry put',
  'Entry delete',
  'Entry read',
  'Entry page',
  'Session start',
  'Session record',
  'Session complete',
  'Session abandon',
  'Session read',
  'Session page',
  'Unit page',
  'Change page',
  'Copy create',
  'Copy update',
  'Copy delete',
  'Copy read',
  'Copy page',
  'Follow',
  'Unfollow',
  'Membership follow',
  'Follow read',
  'Follow page',
  'Publish',
  'Retract',
  'Published log read',
  'Published log page',
  'Member listing effect',
  'Listing-change workflow',
] as const;

const bulletLabels = ['Touches:', 'Bound:', 'Growth check:'] as const;
const growthCitation = /`test\/library\/([A-Za-z0-9-]+)\.test\.ts`: `([^`]+)`/g;

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const bodyStart = start + heading.length + 2;
  const next = markdown.slice(bodyStart).search(/\n## /);
  return next === -1 ? markdown.slice(bodyStart) : markdown.slice(bodyStart, bodyStart + next);
}

function bulletTexts(body: string): string[] {
  const bullets: string[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (!current) return;
    bullets.push(current.join(' ').replaceAll(/\s+/g, ' ').trim());
    current = null;
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) {
      flush();
      current = [line.slice(2).trim()];
    } else if (current && /^\s+\S/.test(line)) current.push(line.trim());
    else flush();
  }
  flush();
  return bullets;
}

function declaredTests(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\b(?:test|it)(?:\.[A-Za-z]+)?\(\s*(['"`])/g;
  for (const match of source.matchAll(pattern)) {
    const quote = match[1]!;
    let index = match.index + match[0].length;
    let value = '';
    while (index < source.length) {
      const character = source[index]!;
      if (character === '\\') {
        value += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (character === quote) {
        names.add(value);
        break;
      }
      if (character === '\n') break;
      value += character;
      index += 1;
    }
  }
  return names;
}

test('the library README states what it owns and the privacy rule', () => {
  const markdown = readFileSync(readmePath, 'utf8');
  let position = -1;
  for (const heading of sections) {
    const found = markdown.indexOf(`\n${heading}\n`);
    expect(found, heading).toBeGreaterThan(position);
    position = found;
  }

  const scope = section(markdown, '## Scope');
  for (const term of scopeTerms) expect(scope, term).toContain(term);

  const partitions = section(markdown, '## Partitions');
  expect(partitions).toContain("Everything personal lives in the owner's partition.");
  expect(partitions).toContain('carrying only `public_collection_count` and pair rows');

  const privacy = section(markdown, '## Privacy');
  expect(privacy).toContain('Private state never reaches public full text, counts or "who also read".');
  expect(privacy).toContain('Only public Collections and published logs are public.');
  expect(privacy).toContain(
    'Events about private state use the account or Collection id as `subject`, never a subject id.',
  );

  const ordering = section(markdown, '## Ordering');
  expect(ordering).toContain('fractional-indexing');
  expect(ordering).toContain('48');
  expect(ordering).toContain('orderEpoch');
});

test('every Cost subsection names a growth test that exists', () => {
  const markdown = readFileSync(readmePath, 'utf8');
  const cost = section(markdown, '## Cost');
  expect(cost).not.toContain('|');
  const introEnd = cost.search(/^### /m);
  expect(introEnd).toBeGreaterThan(0);
  const intro = cost.slice(0, introEnd);
  expect(intro).toContain('`N` is total rows');
  expect(intro).toContain('`P` is');
  expect(intro).toContain('`L(N) = O(log(2+N))`');
  expect(intro).toContain('`R`');
  expect(intro).toContain('`B`');
  expect(intro).toContain('`S`');

  const found = new Map<string, string[]>();
  for (const part of cost.split(/^### /m).slice(1)) {
    const newline = part.indexOf('\n');
    expect(newline).toBeGreaterThan(0);
    const title = part.slice(0, newline).trim();
    expect(title).not.toBe('');
    expect(found.has(title), title).toBe(false);
    const bullets = bulletTexts(part.slice(newline + 1));
    expect(bullets, title).toHaveLength(bulletLabels.length);
    const labels = bullets.map((bullet) => bulletLabels.find((label) => bullet.startsWith(label)));
    expect(labels, title).toEqual([...bulletLabels]);
    for (const [index, bullet] of bullets.entries()) {
      expect(bullet.slice(bulletLabels[index]!.length).trim(), `${title} ${bulletLabels[index]}`).not.toBe('');
    }
    found.set(title, bullets);
  }

  for (const operation of operations) expect(found.has(operation), operation).toBe(true);

  const sources = new Map<string, Set<string>>();
  for (const [title, bullets] of found) {
    const growth = bullets[2]!;
    const citations = [...growth.matchAll(growthCitation)];
    expect(citations.length, title).toBeGreaterThan(0);
    for (const citation of citations) {
      const file = `test/library/${citation[1]}.test.ts`;
      const name = citation[2]!;
      let declared = sources.get(file);
      if (!declared) {
        declared = declaredTests(readFileSync(join(kernel, file), 'utf8'));
        sources.set(file, declared);
      }
      expect(declared.has(name), `${title} -> ${file}: ${name}`).toBe(true);
    }
  }
});
