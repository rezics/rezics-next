import { expect } from 'bun:test';
import type { LibraryProfile } from '@rezics/definitions';
import type { FilterDocument } from '@rezics/filter';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type DiscoveryPersona,
} from '../../support/released-discovery.ts';

export function ownerStatus(response: HttpResponse, status: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
}

export function ownerRecord(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected native response object, received ${JSON.stringify(value)}`);
}

export function ownerString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected native response string, received ${JSON.stringify(value)}`);
  return value;
}

/** Ordinary APIs supply the facts; the existing released driver owns Auth and release setup. */
export async function createOwnerFilterFixture(
  options: Pick<NonNullable<Parameters<typeof createReleasedDiscoveryFixture>[0]>, 'kernelPool' | 'search'> = {},
) {
  const native = await createReleasedDiscoveryFixture({ version: 1, ...options });
  try {
    await native.setup.openFeatures(['personal_library', 'reading_progress']);
    const type = 'schema:Book';
    const profileId = native.release.definition.types[type]?.library?.profileId;
    expect(profileId, 'The actual released Book accepting profile is required').toBeString();
    const profile: LibraryProfile | undefined = native.release.definition.libraryProfiles?.[profileId!];
    expect(profile).toBeDefined();
    const stateSet = profile!.entryStateSet;
    expect(stateSet).toBeDefined();
    const state = stateSet!.states.find((choice) => choice.role === 'active');
    expect(state).toBeDefined();
    const scalar = profile!.progress?.allowed.find((choice) => choice.mode === 'scalar_amount');
    const unit = scalar?.units.find((choice) => choice.totalPolicy !== 'required');
    expect(unit).toBeDefined();
    const copyKind = profile!.copies?.kinds.find((choice) => choice.statuses.length > 0);
    expect(copyKind).toBeDefined();
    const [entry, labelOnly, sessionOnly, copyOnly, noEntry] = await Promise.all(
      ['entry', 'label-only', 'session-only', 'copy-only', 'no-entry'].map((name) =>
        native.createSubject(type, `Owner filter ${name}`),
      ),
    );
    const subjects = {
      entry: entry!,
      labelOnly: labelOnly!,
      sessionOnly: sessionOnly!,
      copyOnly: copyOnly!,
      noEntry: noEntry!,
    };
    const written = await native.request(
      'alice',
      'PUT',
      `/v1/libraryEntries/${subjects.entry.id}`,
      { state: state!.id },
      discoveryKey(),
    );
    ownerStatus(written, 201);
    const label = await native.request('alice', 'POST', '/v1/libraryLabels', { name: 'Owner filter' }, discoveryKey());
    ownerStatus(label, 201);
    const labelValue = label.body.label;
    ownerRecord(labelValue);
    const labelId = ownerString(labelValue.id);
    ownerStatus(
      await native.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${labelId}:assign`,
        { subjectId: subjects.labelOnly.id },
        discoveryKey(),
      ),
      200,
    );
    async function complete(subjectId: string, persona: 'alice' | 'bob' = 'alice') {
      const started = await native.request(
        persona,
        'POST',
        '/v1/progressSessions',
        {
          subjectId,
          mode: 'scalar_amount',
          unit: unit!.id,
        },
        discoveryKey(),
      );
      ownerStatus(started, 201);
      const session = started.body.progressSession;
      ownerRecord(session);
      const sessionId = ownerString(session.id);
      expect(Number.isSafeInteger(session.revision)).toBe(true);
      ownerStatus(
        await native.request(
          persona,
          'POST',
          `/v1/progressSessions/${sessionId}:complete`,
          {
            revision: session.revision,
          },
          discoveryKey(),
        ),
        200,
      );
    }
    await complete(subjects.sessionOnly.id);
    await complete(subjects.noEntry.id, 'bob');
    ownerStatus(
      await native.request(
        'alice',
        'POST',
        '/v1/copies',
        {
          subjectId: subjects.copyOnly.id,
          kind: copyKind!.id,
          status: copyKind!.statuses[0]!.id,
        },
        discoveryKey(),
      ),
      201,
    );
    const created = await native.request(
      'alice',
      'POST',
      '/v1/collections',
      {
        title: 'Complete owner-filter population',
        visibility: 'public',
      },
      discoveryKey(),
    );
    ownerStatus(created, 201);
    const collection = created.body.collection;
    ownerRecord(collection);
    const collectionId = ownerString(collection.id);
    for (const subject of Object.values(subjects))
      ownerStatus(
        await native.request(
          'alice',
          'POST',
          `/v1/collections/${collectionId}/members`,
          {
            subjectId: subject.id,
          },
          discoveryKey(),
        ),
        201,
      );
    const leaves = {
      presence: { owner: { presence: true } },
      state: { owner: { state: { profileId: profileId!, stateSetId: stateSet!.id, in: [state!.id] } } },
      label: { owner: { label: { id: labelId } } },
      session: { owner: { session: { profileId: profileId!, lifecycle: 'completed' } } },
      holding: { owner: { holding: { profileId: profileId! } } },
      qualifiedHolding: {
        owner: {
          holding: {
            profileId: profileId!,
            kind: copyKind!.id,
            status: copyKind!.statuses[0]!.id,
          },
        },
      },
    } satisfies Record<string, FilterDocument>;
    function path(filter: FilterDocument, cursor?: string, id = collectionId, limit = 2) {
      const query = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: String(limit) });
      if (cursor !== undefined) query.set('cursor', cursor);
      return `/v1/collections/${id}/members?${query}`;
    }
    async function members(filter: FilterDocument, persona: DiscoveryPersona = 'alice', id = collectionId) {
      const ids: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await native.request(persona, 'GET', path(filter, cursor, id));
        ownerStatus(response, 200);
        expect(response.headers.get('cache-control')).toContain('private');
        expect(response.headers.get('cache-control')).toContain('no-store');
        const page = response.body.members;
        if (!Array.isArray(page)) throw new Error('Expected native Collection member array');
        const next = response.body.next;
        if (next !== null && typeof next !== 'string') throw new Error('Expected native Collection next cursor');
        expect(page.length).toBeLessThanOrEqual(2);
        if (next !== null) {
          expect(page).toHaveLength(2);
          expect(cursors.has(next)).toBe(false);
          cursors.add(next);
        }
        for (const row of page) {
          ownerRecord(row);
          ids.push(ownerString(row.subjectId));
        }
        expect(cursors.size).toBeLessThan(20);
        cursor = next ?? undefined;
      } while (cursor !== undefined);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort());
      return ids;
    }
    return {
      native,
      subjects,
      leaves,
      type,
      profileId: profileId!,
      stateSet: stateSet!,
      state: state!,
      labelId,
      written,
      collectionId,
      path,
      members,
      complete,
      close: () => native.close(),
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}

export type OwnerFilterFixture = Awaited<ReturnType<typeof createOwnerFilterFixture>>;
