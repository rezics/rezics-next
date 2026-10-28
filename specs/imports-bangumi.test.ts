import { expect, spyOn, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { documentText, parseDocument } from '@rezics/document';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import fixture from './fixtures/imports/bangumi/subject.json';
import type { BangumiDriver, CommandProposal, ConversionInput, ProposedField } from './imports-bangumi-driver';

const SOURCE = 'https://bgm.tv/subject/424242';
const SUBJECT = '00000000-0000-4000-8000-000000000001';
const MEDIA = '00000000-0000-4000-8000-000000000002';
const context = { subjectId: SUBJECT, mediaIds: { [fixture.images.large]: MEDIA } };
// Explicit catalogue prefix expansion; unknown aliases are never accepted.
function classMeaning(value: unknown) {
  expect(typeof value).toBe('string');
  return (value as string)
    .replace(/^schema:/, 'http://schema.org/')
    .replace(/^https:\/\/schema\.org\//, 'http://schema.org/');
}
function summaryText(value: unknown) {
  const content = value as { language: string; document: unknown };
  expect(content.language).toMatch(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/);
  const document = parseDocument(content.document);
  expect(document.profile).toBe('text');
  return documentText(document);
}
const REVISION = 'archive:2024-04-02:record-17';
const input = (record: unknown = structuredClone(fixture)): ConversionInput => ({
  externalId: '424242',
  recordRevision: REVISION,
  record,
});

async function scenario(run: (driver: BangumiDriver) => void | Promise<void>) {
  // Deliberately loaded inside every scenario so the full missing-driver run executes.
  const location = process.env.IMPORT_BANGUMI_DRIVER;
  if (!location) throw new Error('IMPORT_BANGUMI_DRIVER is required: bind the production bangumi converter');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('Expected an absolute driver path or file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Expected a local driver module');
  const binding = await import(url.href);
  expect(binding.createBangumiDriver).toBeFunction();
  const driver: BangumiDriver = await binding.createBangumiDriver();
  const convert = driver.convert.bind(driver);
  driver.convert = (request, supplied) => {
    const output = convert(request, supplied);
    if (supplied) expect(driver.inspect(output).fields.filter((f) => f.role === 'type')).toEqual([]);
    const commands = driver.inspect(output).commands.map((pointer) => at(output, pointer) as CommandProposal);
    expect(checkBatchWrite({ commands })).toEqual([]);
    expect(commands.filter((c) => c.op === 'create')).toHaveLength(supplied ? 0 : 1);
    if (!supplied) expect(commands).toHaveLength(1);
    for (const command of commands) {
      expect(command.source.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(command.source).toMatchObject({
        source: 'bangumi',
        external_id: request.externalId,
        record_revision: request.recordRevision,
        converter_revision: text(output, driver.inspect(output).converterRevision),
      });
      if (!supplied) {
        expect(command.op).toBe('create');
        expect(command.subject).not.toHaveProperty('id');
        expect(command.subject).not.toHaveProperty('statements');
        for (const key of Object.keys(command.subject))
          expect(['type', 'labels', 'descriptions', 'aliases']).toContain(key);
        expect(command.source.field_group).toBe('facts');
        expect(command).not.toHaveProperty('rights');
      } else {
        expect(command.op).toBe('propose');
        expect(command.subject).toBe(supplied.subjectId);
        for (const key of ['type', 'labels', 'descriptions', 'aliases']) expect(command).not.toHaveProperty(key);
      }
    }
    return output;
  };
  try {
    await run(driver);
  } finally {
    await driver.close();
  }
}

function at(output: unknown, pointer: string): unknown {
  expect(pointer).toMatch(/^\//);
  let value = output;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    expect(value !== null && typeof value === 'object' && Object.hasOwn(value, key)).toBe(true);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function text(output: unknown, pointer: string): string {
  const value = at(output, pointer);
  expect(typeof value).toBe('string');
  expect((value as string).trim().length).toBeGreaterThan(0);
  return value as string;
}
function field(
  driver: BangumiDriver,
  output: unknown,
  role: ProposedField['role'],
  source = SOURCE,
  phase: 'bootstrap' | 'resolved' = 'resolved',
): ProposedField {
  const inspection = driver.inspect(output);
  const matches = inspection.fields.filter((candidate) => candidate.role === role);
  expect(matches).toHaveLength(1);
  const found = matches[0]!;
  expect(inspection.commands).toContain(found.command);
  expect(at(output, found.command)).toBeObject();
  expect(found.value.startsWith(`${found.command}/`)).toBe(true);
  expect(found.fieldGroup.startsWith(`${found.command}/`)).toBe(true);
  expect(text(output, found.fieldGroup)).toBe(role === 'summary' ? 'summary' : role === 'cover' ? 'cover' : 'facts');
  if (phase === 'bootstrap') {
    expect(found.references).toEqual([]);
    expect((at(output, found.command) as CommandProposal).op).toBe('create');
    expect(found.value.startsWith(`${found.command}/subject/${role === 'type' ? 'type' : 'labels'}`)).toBe(true);
  } else {
    expect(found.references.length).toBeGreaterThan(0);
    for (const pointer of found.references)
      expect(pointer.startsWith(`${found.command}/statement/references/`)).toBe(true);
    expect(found.references.map((pointer) => at(output, pointer))).toContain(source);
  }
  at(output, found.value);
  if (phase === 'resolved' && (role === 'title' || role === 'chinese-label')) {
    const command = at(output, found.command) as CommandProposal;
    expect(checkBatchWrite({ commands: [command] })).toEqual([]);
    expect(command.op).toBe('propose');
    if (command.op !== 'propose') throw new Error('Titles must be source candidates');
    expect(command.statement.property.id).toBe('schema:name');
    expect(command.statement.value).toEqual({
      type: 'value',
      content: {
        text: at(output, found.value),
        language: expect.any(String),
      },
    });
    if (role === 'chinese-label' && command.statement.value.type === 'value') {
      expect((command.statement.value.content as { language: string }).language).toMatch(/^zh(?:-|$)/);
    }
    expect(found.value).toBe(`${found.command}/statement/value/content/text`);
  }
  return found;
}
function reject(driver: BangumiDriver, request: ConversionInput) {
  let error: unknown;
  try {
    driver.convert(request, context);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/invalid|record|unsupported|url|identifier|type/i);
}
function freeze(value: unknown) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

test('source identity and record revision accompany a nonempty converter_revision', () =>
  scenario((driver) => {
    const output = driver.convert(input(), context);
    const view = driver.inspect(output);
    expect(text(output, view.source)).toBe('bangumi');
    expect(text(output, view.externalId)).toBe('424242');
    expect(text(output, view.recordRevision)).toBe(REVISION);
    expect(view.converterRevision.endsWith('/converter_revision')).toBe(true);
    const revision = text(output, view.converterRevision);
    const record = {
      ...structuredClone(fixture),
      id: 424243,
      name: 'Another Observatory',
      name_cn: '另一座天文台',
      summary: 'An entirely different summary, including its final sentence.',
    };
    const changed = driver.convert(
      {
        externalId: '424243',
        recordRevision: 'archive:2024-04-03:record-18',
        record,
      },
      context,
    );
    const next = driver.inspect(changed);
    expect(text(changed, next.externalId)).toBe('424243');
    expect(text(changed, next.recordRevision)).toBe('archive:2024-04-03:record-18');
    expect(text(changed, next.converterRevision)).toBe(revision);
    const digests = (raw: unknown) =>
      driver.inspect(raw).commands.map((p) => (at(raw, p) as CommandProposal).source.digest);
    expect(digests(changed)).not.toEqual(digests(output));
    const edited = driver.convert(input({ ...structuredClone(fixture), name: 'Changed title only' }), context);
    expect(digests(edited)).not.toEqual(digests(output));
    expect(at(edited, field(driver, edited, 'title').value)).toBe('Changed title only');
    for (const [role, value] of [
      ['title', record.name],
      ['chinese-label', record.name_cn],
      ['summary', record.summary],
    ] as const) {
      const actual = at(changed, field(driver, changed, role, 'https://bgm.tv/subject/424243').value);
      expect(role === 'summary' ? summaryText(actual) : actual).toBe(value);
    }
  }));

test('conversion is synchronous deterministic immutable and performs no I/O', () =>
  scenario((driver) => {
    const request = input();
    const before = structuredClone(request);
    freeze(request);
    const attempts: string[] = [];
    const spies: { mockRestore(): void }[] = [];
    function deny<T extends object>(target: T, key: keyof T) {
      spies.push(
        spyOn(target, key as never).mockImplementation((() => {
          attempts.push(String(key));
          throw new Error(`Unexpected converter I/O: ${String(key)}`);
        }) as never),
      );
    }
    // Instrument common sync/async filesystem, process and network boundaries only
    // after the production module is loaded; adapter import/setup is not conversion.
    try {
      deny(globalThis, 'fetch');
      for (const key of ['file', 'write', 'spawn', 'spawnSync', 'connect', 'listen'] as const) deny(Bun, key);
      for (const key of [
        'readFileSync',
        'writeFileSync',
        'appendFileSync',
        'openSync',
        'statSync',
        'readdirSync',
      ] as const)
        deny(fs, key);
      for (const key of ['readFile', 'writeFile', 'appendFile', 'open', 'stat', 'readdir'] as const) {
        deny(promises, key);
        deny(fs, key);
      }
      for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const)
        deny(childProcess, key);
      deny(http, 'request');
      deny(http, 'get');
      deny(https, 'request');
      deny(https, 'get');
      deny(net, 'connect');
      deny(net, 'createConnection');
      const first = driver.convert(request, context);
      const second = driver.convert(structuredClone(before), context);
      expect(first).not.toBeInstanceOf(Promise);
      expect(first).toEqual(second);
      expect(first).toBeObject();
      expect(driver.inspect(first).commands.length).toBeGreaterThan(0);
      expect(request).toEqual(before);
      expect(attempts).toEqual([]);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  }));

test('all supported subject types retain title facts Chinese labels and source references', () =>
  scenario((driver) => {
    for (const [type, name] of [
      [1, 'Book'],
      [2, 'TVSeries'],
      [4, 'VideoGame'],
    ] as const) {
      const output = driver.convert(input({ ...structuredClone(fixture), type }), context);
      expect(at(output, field(driver, output, 'title').value)).toBe(fixture.name);
      const bootstrap = driver.convert(input({ ...structuredClone(fixture), type }));
      expect(classMeaning(at(bootstrap, field(driver, bootstrap, 'type', SOURCE, 'bootstrap').value))).toBe(
        `http://schema.org/${name}`,
      );
      expect(at(output, field(driver, output, 'chinese-label').value)).toBe(fixture.name_cn);
    }
  }));

test('an absent Chinese name never fabricates a Chinese label', () =>
  scenario((driver) => {
    for (const name_cn of ['', undefined]) {
      const record = structuredClone(fixture) as Record<string, unknown>;
      if (name_cn === undefined) delete record.name_cn;
      else record.name_cn = name_cn;
      const output = driver.convert(input(record), context);
      expect(at(output, field(driver, output, 'title').value)).toBe(fixture.name);
      expect(driver.inspect(output).fields.filter((candidate) => candidate.role === 'chinese-label')).toEqual([]);
    }
  }));

test('the full summary retains separate CC-BY-SA-3.0 attribution and ShareAlike rights', () =>
  scenario((driver) => {
    const output = driver.convert(input(), context);
    const summary = field(driver, output, 'summary');
    expect(summaryText(at(output, summary.value))).toBe(fixture.summary);
    expect(
      (at(output, summary.command) as CommandProposal & { statement: { property: { id: string } } }).statement.property
        .id,
    ).toBe('schema:abstract');
    const rights = summary.rights;
    expect(rights).toBeDefined();
    expect(rights!.envelope).toBe(`${summary.command}/rights`);
    expect(rights!.license).toBe(`${summary.command}/rights/license`);
    expect(rights!.credit).toBe(`${summary.command}/rights/attribution`);
    expect(rights!.obligations).toBe(`${summary.command}/rights/obligations`);
    expect(at(output, rights!.envelope)).toBeObject();
    expect(text(output, rights!.license)).toBe('CC-BY-SA-3.0');
    expect(text(output, rights!.credit)).toMatch(/Bangumi/i);
    expect(text(output, rights!.credit)).toMatch(/contributor/i);
    expect(text(output, rights!.originalSource)).toBe(SOURCE);
    expect(at(output, rights!.obligations)).toEqual(expect.arrayContaining(['cc:Attribution', 'cc:ShareAlike']));
    expect(text(output, summary.fieldGroup)).not.toBe(text(output, field(driver, output, 'title').fieldGroup));
    const bootstrap = driver.convert(input());
    expect(text(output, summary.fieldGroup)).not.toBe(
      text(bootstrap, field(driver, bootstrap, 'type', SOURCE, 'bootstrap').fieldGroup),
    );
  }));

test('covers retain original links rights-holder credit and independent takedown eligibility', () =>
  scenario((driver) => {
    const output = driver.convert(input(), context);
    const cover = field(driver, output, 'cover');
    expect(at(output, cover.value)).toBe(MEDIA);
    const command = at(output, cover.command) as CommandProposal;
    expect(command).toMatchObject({
      op: 'propose',
      subject: SUBJECT,
      statement: { property: { id: 'schema:image' }, value: { type: 'value', content: MEDIA } },
    });
    expect(command).not.toHaveProperty('rights');
    const pending = driver.convert(input(), { subjectId: SUBJECT });
    const intent = driver.inspect(pending).coverIntent;
    expect(at(pending, intent.sourceUrl)).toBe(fixture.images.large);
    expect(text(pending, intent.credit)).toMatch(/\(c\)|copyright|©|rights[ -]?holder/i);
    expect(text(pending, intent.credit)).toMatch(/rights[ -]?holder/i);
    expect(text(pending, intent.credit)).toMatch(/via.*Bangumi/i);
    expect(JSON.stringify(at(pending, intent.provenance))).toContain(JSON.stringify(SOURCE));
    expect(at(pending, intent.role)).toBe('cover');
    expect(at(pending, intent.takedownEligible)).toBe(true);
    expect(
      new Set<unknown>([null, 'NOASSERTION', 'unknown']).has(at(pending, intent.license)) ||
        /^LicenseRef-/.test(String(at(pending, intent.license))),
    ).toBe(true);
    expect(driver.inspect(pending).fields.filter((f) => f.role === 'cover')).toEqual([]);
    const pendingCommands = driver.inspect(pending).commands.map((p) => at(pending, p));
    expect(checkBatchWrite({ commands: pendingCommands })).toEqual([]);
    expect(command.op).toBe('propose');
    if (command.op !== 'propose') throw new Error('Expected cover proposal');
    expect(JSON.stringify(command.statement.references)).toContain(JSON.stringify(fixture.images.large));
    // This proves intent and media-ID binding only; the API suite proves byte processing.
    expect(cover.rights).toBeDefined();
    const rights = cover.rights!;
    expect(at(output, rights.envelope)).toBeObject();
    const license = at(output, rights.license);
    expect(
      license === null ||
        license === 'NOASSERTION' ||
        license === 'unknown' ||
        (typeof license === 'string' && /^LicenseRef-.+/.test(license)),
    ).toBe(true);
    expect(text(output, rights.credit)).toMatch(/\(c\)|copyright|©|rights[ -]?holder/i);
    expect(text(output, rights.credit)).toMatch(/rights[ -]?holder/i);
    expect(text(output, rights.credit)).not.toMatch(/Bangumi contributors/i);
    expect(text(output, rights.originalSource)).toBe(SOURCE);
    expect(text(output, rights.credit)).toMatch(/via.*Bangumi/i);
    expect(at(output, rights.takedownEligible)).toBe(true);
    const summary = field(driver, output, 'summary');
    expect(at(output, rights.envelope)).not.toEqual(at(output, summary.rights!.envelope));
    expect(at(output, rights.license)).toEqual(at(pending, intent.license));
    expect(text(output, cover.fieldGroup)).not.toBe(text(output, summary.fieldGroup));
    expect(text(output, cover.fieldGroup)).not.toBe(text(output, field(driver, output, 'title').fieldGroup));
    const bootstrap = driver.convert(input());
    expect(text(output, cover.fieldGroup)).not.toBe(
      text(bootstrap, field(driver, bootstrap, 'type', SOURCE, 'bootstrap').fieldGroup),
    );
  }));

test('user posts comments reviews and account identifiers never enter proposals or references', () =>
  scenario((driver) => {
    const clean = structuredClone(fixture) as Record<string, unknown>;
    for (const key of ['user_posts', 'comments', 'reviews', 'account_id']) delete clean[key];
    const output = driver.convert(input(), context);
    // Whole-output equality also catches leaks in rights, diagnostics and source snapshots.
    expect(output).toEqual(driver.convert(input(clean), context));
    expect(at(output, field(driver, output, 'title').value)).toBe(fixture.name);
  }));

test('invalid mismatched and unsafe external identifiers reject clearly', () =>
  scenario((driver) => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '424242', null]) {
      reject(driver, input({ ...structuredClone(fixture), id }));
    }
    for (const externalId of ['', '424243', '0424242', '../424242', '424242?x=1']) {
      reject(driver, { ...input(), externalId });
    }
  }));

test('unsupported and malformed source types reject clearly', () =>
  scenario((driver) => {
    for (const type of [0, 5, 7, -1, 2.5, '2', null, {}, undefined]) {
      reject(driver, input({ ...structuredClone(fixture), type }));
    }
  }));

test('malformed records and required titles reject clearly', () =>
  scenario((driver) => {
    for (const record of [
      null,
      [],
      'subject',
      {},
      42,
      { ...fixture, name: '' },
      { ...fixture, name: 42 },
      { ...fixture, name: 'x'.repeat(501) },
      { ...fixture, summary: {} },
      { ...fixture, images: [] },
    ]) {
      reject(driver, input(record));
    }
  }));

test('hostile cover URLs reject without becoming references or performing fetches', () =>
  scenario((driver) => {
    for (const url of [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
      'file:///etc/passwd',
      'http://127.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
      'https://user:secret@lain.bgm.tv/a.jpg',
      'https://lain.bgm.tv.evil.invalid/a.jpg',
      '//evil.invalid/a.jpg',
      'https://lain.bgm.tv/a.jpg\r\nX-Test: injected',
    ]) {
      const fetch = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          () => {
            throw new Error('Unexpected URL fetch');
          },
          {
            preconnect() {
              throw new Error('Unexpected URL preconnect');
            },
          },
        ),
      );
      try {
        reject(driver, input({ ...structuredClone(fixture), images: { ...fixture.images, large: url } }));
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    }
  }));

test('unknown nested fields are ignored without acquiring authority or disclosing private text', () =>
  scenario((driver) => {
    const baseline = driver.convert(input(), context);
    const record = {
      ...structuredClone(fixture),
      converter_revision: 'forged',
      source: 'javascript:alert(1)',
      rights: { license: 'CC0-1.0' },
      future_extension: {
        text: 'UNKNOWN_PRIVATE_SENTINEL',
        rights: 'CC0-1.0',
        source: 'javascript:alert(1)',
        account_id: 'UNKNOWN_ACCOUNT_SENTINEL',
        command: 'delete-all',
        converter_revision: 'forged',
      },
    };
    expect(driver.convert(input(record), context)).toEqual(baseline);
    expect(summaryText(at(baseline, field(driver, baseline, 'summary').value))).toBe(fixture.summary);
  }));

test('the semantic bulk consumer structurally accepts actual proposals and preserves cited sources', () =>
  scenario((driver) => {
    const output = driver.convert(input(), context);
    const view = driver.inspect(output);
    expect(view.commands.length).toBeGreaterThan(0);
    expect(new Set(view.commands).size).toBe(view.commands.length);
    const received: CommandProposal[] = [];
    driver.offer(output, {
      accept(proposal) {
        expect(proposal).toBeObject();
        expect(Object.keys(proposal).length).toBeGreaterThan(0);
        expect(checkBatchWrite({ commands: [proposal] })).toEqual([]);
        received.push(proposal);
      },
    });
    expect<unknown>(received).toEqual(view.commands.map((pointer) => at(output, pointer)));
    expect(checkBatchWrite({ commands: received })).toEqual([]);
    expect(received.filter((c) => c.op === 'create')).toHaveLength(0);
    for (const command of received) {
      if (command.op !== 'create') expect(command.subject).toBe(SUBJECT);
      if (command.source.field_group === 'facts') expect(command).not.toHaveProperty('rights');
      expect(command.source.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const role of ['title', 'chinese-label', 'summary', 'cover'] as const) {
      const proposed = field(driver, output, role);
      const index = view.commands.indexOf(proposed.command);
      // The citation survives in the exact command accepted by the fake consumer.
      expect<unknown>(received[index]).toEqual(at(output, proposed.command));
      for (const pointer of proposed.references) {
        expect(pointer.startsWith(`${proposed.command}/`)).toBe(true);
        expect(at(received[index], pointer.slice(proposed.command.length))).toBe(SOURCE);
      }
    }
    for (const malformed of [null, {}, [], { proposals: [{}] }]) {
      const accepted: unknown[] = [];
      expect(() =>
        driver.offer(malformed, {
          accept: (proposal) => {
            accepted.push(proposal);
          },
        }),
      ).toThrow();
      expect(accepted).toEqual([]);
    }
  }));

test('unresolved Bangumi bootstrap carries only creation metadata and source provenance', () =>
  scenario((driver) => {
    const output = driver.convert(input());
    const commands: CommandProposal[] = [];
    driver.offer(output, {
      accept: (command) => {
        commands.push(command);
      },
    });
    expect<unknown>(commands).toEqual(driver.inspect(output).commands.map((p) => at(output, p)));
    expect(checkBatchWrite({ commands })).toEqual([]);
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.op).toBe('create');
    if (command.op !== 'create') throw new Error('Expected bootstrap create');
    expect(classMeaning(command.subject.type)).toBe('http://schema.org/TVSeries');
    expect(Object.values(command.subject.labels)).toContain(fixture.name);
    // The licensed summary stays in the resolved schema:abstract proposal.
    expect(Object.values(command.subject.descriptions ?? {})).not.toContain(fixture.summary);
    expect(
      Object.entries(command.subject.labels)
        .filter(([language]) => /^zh(?:-|$)/.test(language))
        .map(([, value]) => value),
    ).toContain(fixture.name_cn);
    expect(command.source).toMatchObject({
      source: 'bangumi',
      external_id: '424242',
      record_revision: REVISION,
      field_group: 'facts',
    });
    for (const role of ['type', 'title', 'chinese-label'] as const) {
      const actual = field(driver, output, role, SOURCE, 'bootstrap');
      expect(actual.command).toBe(driver.inspect(output).commands[0]!);
    }
    expect(driver.inspect(output).fields.filter((f) => f.role === 'summary' || f.role === 'cover')).toEqual([]);
    expect(command.subject).not.toHaveProperty('statements');
    for (const key of Object.keys(command.subject))
      expect(['type', 'labels', 'descriptions', 'aliases']).toContain(key);
  }));
