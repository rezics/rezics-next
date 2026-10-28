import { expect, test } from 'bun:test';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import type { CoverSummary } from '../../src/semantic/summaries.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { openCoverRecovery, isCover, type CoverRecovery } from './cover-native-recovery-fixture.ts';

function coverMedia(command: BatchCommand): string {
  if (
    command.op !== 'propose' ||
    command.statement.value.type !== 'value' ||
    typeof command.statement.value.content !== 'string'
  )
    throw new Error('Missing actual cover media reference');
  return command.statement.value.content;
}
type SubjectBody = {
  subject: { id: string; statements: Record<string, unknown[]> };
  summary: { cover: CoverSummary | null };
};
async function publicSubject(f: CoverRecovery) {
  const response = await f.runtime.request(`/v1/subjects/${f.subject()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubjectBody;
}
async function disclose(f: CoverRecovery, media: string | null) {
  const body = await publicSubject(f);
  expect(body.subject.id).toBe(f.subject());
  expect(body.subject.statements['schema:name']!.length).toBeGreaterThan(0);
  expect(body.subject.statements['schema:abstract']!.length).toBeGreaterThan(0);
  if (media === null) expect(body.summary.cover).toBeNull();
  else {
    expect(body.summary.cover?.media).toBe(media);
    const selected = JSON.stringify(body.subject.statements['schema:image']);
    expect(selected).toContain(`https://bgm.tv/subject/${f.owner.external_id}`);
    const native = await f.runtime.mediaBoundary.observe(media);
    expect(selected).toContain(native.row.sourceUrl);
    const cover = body.summary.cover!;
    expect(cover.credit).toMatchObject({
      rightsHolder: '(c) rights holder',
      via: { name: 'Bangumi', url: `https://bgm.tv/subject/${f.owner.external_id}` },
      license: 'LicenseRef-unknown',
    });
    expect(`${cover.credit.rightsHolder} via ${cover.credit.via.name}`).toBe('(c) rights holder via Bangumi');
    expect(cover.variants.length).toBeGreaterThan(0);
    const variant = cover.variants[0]!;
    const response = await f.runtime.request(
      `/v1/media/${media}:authorizeDownload?variant=${variant.format}-${variant.width}`,
    );
    expect(response.status).toBe(200);
    const decision = (await response.json()) as { allowed: boolean; key?: string };
    expect(decision.allowed).toBe(true);
    expect((await f.runtime.mediaBoundary.configuration.storage.get(decision.key!))!.byteLength).toBeGreaterThan(0);
    const original = await f.runtime.request(`/v1/media/${media}:authorizeDownload?variant=original`);
    expect(original.status).toBe(404);
    expect(await original.json()).toMatchObject({ status: 404, code: 'not_found' });
  }
  // This is the mounted production page route and body, not a rendering client substitute.
  const page = await f.runtime.request('/v1/pages:read', { target: { subject: f.subject() } });
  expect(page.status).toBe(200);
  const published = (await page.json()) as {
    subject: string;
    reads: Record<string, { status: number; body: SubjectBody }>;
  };
  expect(published.subject).toBe(f.subject());
  const subjectRead = Object.values(published.reads).find((read) => read.body?.subject?.id === f.subject());
  expect(subjectRead?.status).toBe(200);
  expect(subjectRead!.body.summary.cover?.media ?? null).toBe(media);
}
async function selectFacts(f: CoverRecovery) {
  for (const property of ['schema:name', 'schema:abstract']) {
    const candidate = (await f.listing(property)).candidates.find((entry) => entry.retracted === null);
    expect(candidate).toBeDefined();
    await f.select(property, candidate!.id);
  }
}
async function mediaEvidence(f: CoverRecovery, media: string, version: number) {
  const native = await f.runtime.mediaBoundary.observe(media);
  expect(native.row.state).toBe('available');
  expect(native.row.sourceUrl).toBe(f.urls[version]!);
  expect(native.row.credit.license).toBe('LicenseRef-unknown');
  expect(native.row.provenance).toMatchObject({
    source: f.owner.source,
    external_id: f.owner.external_id,
    field_group: 'cover',
  });
  expect(JSON.stringify(native.row.provenance.references)).toContain(f.urls[version]!);
  expect(JSON.stringify(native.row.provenance.references)).toContain(`https://bgm.tv/subject/${f.owner.external_id}`);
  expect(f.pending).toContain(media);
  expect(f.resolved).toContain(media);
  const capture = await f.runtime.mediaBoundary.capture();
  expect(capture.registrations.map((entry) => entry.name)).toContain(CONTENT_WORKFLOWS.importFromUrl);
  expect(capture.registrations.map((entry) => entry.name)).toContain(CONTENT_WORKFLOWS.image);
  expect(capture.sourceRequests.map((entry) => entry.url)).toContain(f.urls[version]!);
  expect(capture.liveInternetRequests).toEqual([]);
}
async function replay(f: CoverRecovery, version: number) {
  const before = f.covers();
  const receipts = await Promise.all(f.acknowledgements.map((ack) => f.runtime.receipt(ack.command.key)));
  const commands = f.acknowledgements.length;
  const media = f.pending.length;
  expect((await f.run(version)).status).toBe('committed');
  expect(f.covers()).toEqual(before);
  expect(f.acknowledgements).toHaveLength(commands);
  expect(f.pending).toHaveLength(media);
  expect(await Promise.all(f.acknowledgements.map((ack) => f.runtime.receipt(ack.command.key)))).toEqual(receipts);
}
async function recover(f: CoverRecovery, version: number) {
  expect((await f.run(version, true)).status).toBe('interrupted');
  expect(f.faultCount).toBe(1);
  const ack = f.interrupted;
  expect(ack.command.op).toBe('propose');
  expect(isCover(ack.command)).toBe(true);
  if (!('value' in ack.result) || !('candidate' in ack.result.value)) throw new Error('Missing native proposal ACK');
  const candidate = ack.result.value.candidate;
  const media = coverMedia(ack.command);
  expect(
    (await f.listing('schema:image')).candidates.some((entry) => entry.id === candidate && entry.retracted === null),
  ).toBe(true);
  await mediaEvidence(f, media, version);
  await f.reopen();
  expect((await f.run(version)).status).toBe('committed');
  expect(f.covers().map((entry) => entry.candidate)).toEqual([candidate]);
  expect((JSON.parse(f.covers()[0]!.bytes) as BatchWriteRequest).commands).toEqual([ack.command]);
  expect(await f.runtime.receipt(ack.command.key)).toBe(ack.receipt);
  expect(
    f.acknowledgements.filter((entry) => entry.command.op === 'retract' && entry.command.candidate === candidate),
  ).toEqual([]);
  const covers = (await f.listing('schema:image')).candidates;
  expect(covers.filter((entry) => entry.retracted === null).map((entry) => entry.id)).toEqual([candidate]);
  expect(f.pending).toHaveLength(version + 1);
  await replay(f, version);
  await selectFacts(f);
  await f.select('schema:image', candidate);
  await disclose(f, media);
  return { candidate, media };
}

test('native new-cover acknowledgement survives interruption before local deferred completion', async () => {
  const f = await openCoverRecovery();
  try {
    await recover(f, 0);
  } finally {
    await f.close();
  }
}, 600_000);

test('native changed-cover acknowledgement survives interruption and subsequent replacement remains correctly credited', async () => {
  const f = await openCoverRecovery();
  try {
    expect((await f.run()).status).toBe('committed');
    const older = f.covers()[0]!.candidate;
    const recovered = await recover(f, 1);
    expect(
      f.acknowledgements.filter((ack) => ack.command.op === 'retract' && ack.command.candidate === older),
    ).toHaveLength(1);
    expect((await f.run(2)).status).toBe('committed');
    const replacement = f.covers()[0]!;
    expect(replacement.candidate).not.toBe(recovered.candidate);
    const command = (JSON.parse(replacement.bytes) as BatchWriteRequest).commands[0]!;
    if (command.op !== 'propose') throw new Error('Missing replacement proposal');
    const media = coverMedia(command);
    expect(media).not.toBe(recovered.media);
    await mediaEvidence(f, media, 2);
    // Retraction does not erase an independent community adoption or old media bytes.
    await f.select('schema:image', replacement.candidate);
    await disclose(f, media);
    expect((await f.runtime.mediaBoundary.observe(recovered.media)).variants.length).toBeGreaterThan(0);
    expect(
      f.acknowledgements.filter((ack) => ack.command.op === 'retract' && ack.command.candidate === recovered.candidate),
    ).toHaveLength(1);
    await replay(f, 2);
    expect(new Set(f.pending).size).toBe(3);
  } finally {
    await f.close();
  }
}, 600_000);

test('a fenced cover during native recovery is never restored while adjacent unfenced facts remain readable', async () => {
  const f = await openCoverRecovery();
  try {
    expect((await f.run(0, true)).status).toBe('interrupted');
    expect(f.faultCount).toBe(1);
    const cover = f.covers()[0]!;
    const command = (JSON.parse(cover.bytes) as BatchWriteRequest).commands[0]!;
    if (command.op !== 'propose') throw new Error('Missing acknowledged cover');
    const media = coverMedia(command);
    await selectFacts(f);
    await f.select('schema:image', cover.candidate);
    await disclose(f, media);
    await f.fence(media);
    const receipt = f.interrupted.receipt;
    await f.reopen();
    expect((await f.run()).status).toBe('committed');
    expect(await f.runtime.receipt(command.key)).toBe(receipt);
    await replay(f, 0);
    await disclose(f, null);
    const denied = await f.runtime.request(`/v1/media/${media}:authorizeDownload?variant=webp-48`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ status: 404, code: 'not_found' });
    expect(f.pending).toHaveLength(1);
    expect(f.acknowledgements.filter((ack) => ack.command.op === 'propose' && isCover(ack.command))).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 600_000);
