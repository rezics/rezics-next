import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { OpenLibraryConversionStore } from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { compareSourceChildren, sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import { identityHarness } from './source-identity-harness.ts';

type WorkVersion = { key: string; revision?: number; latest_revision?: number;
  subjects?: unknown; authors?: unknown };

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('LIVE04: retained Open Library versions expose reordered or reused child keys', async () => {
  const h = await identityHarness({ realAccount: true });
  try {
    const intake = new SourceIntakeStore(h.pool);
    const workId = 'OL45804W';
    const capture = async (revision: number | null) => {
      await intake.reserveOpenLibrarySlot();
      const url = `https://openlibrary.org/works/${workId}.json${revision === null ? '' : `?v=${revision}`}`;
      const response = await fetch(url, { headers: { accept: 'application/json',
        'user-agent': 'REZICS-source-capture/1 (single-record version evidence)' },
      signal: AbortSignal.timeout(10_000), redirect: 'error' });
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBeLessThanOrEqual(65_536);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as WorkVersion;
      expect(value.key).toBe(`/works/${workId}`);
      expect(value.revision).toBe(revision ?? value.revision);
      return { url, revision: value.revision, latest: value.latest_revision,
        bytes, byteDigest: digest(bytes), value, fetchedAt: new Date().toISOString(),
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    };
    const current = await capture(null);
    const latest = current.latest ?? current.revision;
    expect(latest).toBeGreaterThan(2);
    const versions = [current];
    for (let offset = 1; offset <= Math.min(12, latest! - 1); offset++) {
      versions.push(await capture(latest! - offset));
    }
    const changed = versions.flatMap((base, index) => versions.slice(index + 1).flatMap(candidate => {
      const a = Array.isArray(base.value.subjects) ? base.value.subjects : null;
      const b = Array.isArray(candidate.value.subjects) ? candidate.value.subjects : null;
      if (!a || !b || a.some(item => typeof item !== 'string')
        || b.some(item => typeof item !== 'string')) return [];
      const moved = a.find((key, ordinal) => b.includes(key) && b.indexOf(key) !== ordinal);
      const repeated = a.find(key => a.indexOf(key) !== a.lastIndexOf(key))
        ?? b.find(key => b.indexOf(key) !== b.lastIndexOf(key));
      return moved || repeated ? [{ base, candidate, key: moved ?? repeated,
        status: moved ? 'reordered' : 'reused' }] : [];
    }));
    expect(changed.length).toBeGreaterThan(0);
    const selected = changed[0]!;
    expect(selected.base.byteDigest).toBe(digest(selected.base.bytes));
    expect(selected.candidate.byteDigest).toBe(digest(selected.candidate.bytes));
    expect(selected.base.url).not.toBe(selected.candidate.url);
    expect(selected.status).toMatch(/reordered|reused/);
    const conversions = new OpenLibraryConversionStore(h.pool, intake);
    const stage = async (selectedVersion: typeof selected.base) => {
      const staged = await intake.submit(h.principalId, `live-child-${selectedVersion.revision}`, {
        provider: 'open-library', namespace: 'work', externalId: workId,
        sourceRevision: `open-library-revision:${selectedVersion.revision}`,
        mediaType: 'application/json', retention: 'retained',
        rawBytesBase64: selectedVersion.bytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: 'Public provider metadata; no rights decision' },
      }, { profile: 'open-library-work-acquisition-v1', url: selectedVersion.url, status: 200,
        fetchedAt: selectedVersion.fetchedAt, etag: selectedVersion.etag,
        lastModified: selectedVersion.lastModified });
      expect(staged.observation.byteDigest).toBe(selectedVersion.byteDigest);
      const converted = await conversions.convert(h.principalId, staged.observation.observation.split('/').at(-1)!);
      expect(converted).not.toBeNull();
      return { staged: staged.observation, converted: converted!.conversion };
    };
    const base = await stage(selected.base), candidate = await stage(selected.candidate);
    expect(base.staged.record).toBe(candidate.staged.record);
    const assessment = await compareSourceChildren(conversions, h.principalId,
      base.converted.conversion.split('/').at(-1)!, candidate.converted.conversion.split('/').at(-1)!);
    const subjects = assessment?.fields.find(field => field.field === 'subjects');
    expect(subjects?.coverage).toBe('complete');
    const left = subjects!.base.find(child => child.sourceKey === selected.key);
    const right = subjects!.candidate.find(child => child.sourceKey === selected.key);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left!.occurrence).toBe(sourceChildOccurrence(base.staged.observation, 'subjects', left!.ordinal));
    expect(right!.occurrence).toBe(sourceChildOccurrence(candidate.staged.observation, 'subjects', right!.ordinal));
    expect(left!.occurrence).not.toBe(right!.occurrence);
    if (selected.status === 'reordered' && left!.status === 'matched') {
      expect(left!.correspondence).toBe(right!.occurrence);
      expect(right!.correspondence).toBe(left!.occurrence);
    } else {
      expect(left!.status).toBe('ambiguous');
      expect(right!.status).toBe('ambiguous');
      const decision = await new SourceChildCorrespondenceStore(h.pool, conversions)
        .record(h.principalId, 'live-child-pair', {
          baseConversion: base.converted.conversion.split('/').at(-1)!,
          candidateConversion: candidate.converted.conversion.split('/').at(-1)!,
          field: 'subjects', baseOccurrence: left!.occurrence,
          candidateOccurrence: right!.occurrence });
      expect(decision?.correspondence.sourceKey).toBe(selected.key);
    }
  } finally { await h.close(); }
}, 60_000);
