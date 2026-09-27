import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bootstrapStructureOwner, StructureBootstrapConflict }
  from '../../../services/main/src/modules/structure/bootstrap.ts';
import { canReadStructureTarget, structureProfileFor }
  from '../../../services/main/src/modules/structure/profiles.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('STRUCTURE target policy: a profile decides native target disclosure and catalogs stay public',
  async () => {
    const zone = structureProfileFor('zone-navigation');
    const target = id();
    const seen: string[] = [];
    const authority = { principal: { issuer: 'test', subject: 'reader' },
      actingSubject: id(), target,
      access: {
        canReadWork: async () => { seen.push('work'); return false; },
        canReadSemanticResource: async () => { seen.push('semantic'); return false; },
      } };
    const custom = { ...zone, authorizeTarget: async (input: typeof authority) => {
      seen.push(input.target);
      return input.target === target;
    } };
    expect(await canReadStructureTarget(custom, authority)).toBe(true);
    expect(seen).toEqual([target]);
    expect(await canReadStructureTarget(zone, authority)).toBe(false);
    expect(seen).toEqual([target, 'semantic']);
    expect(await canReadStructureTarget(custom, { ...authority, target: 'https://example.org/private' }))
      .toBe(false);
    const book = structureProfileFor('book-composition');
    expect(await canReadStructureTarget(book, { ...authority, target: 'https://schema.org/Book' }))
      .toBe(true);
    expect(await canReadStructureTarget(book, authority)).toBe(false);
    expect(seen).toEqual([target, 'semantic', 'work']);
  });

test('STRUCTURE owner bootstrap: receipts resume after crashes on either side of Structure creation',
  async () => {
    const input = { profile: 'zone-navigation' as const, owner: id(), actingSubject: id(),
      idempotencyKey: `bootstrap-${randomUUID()}`, requestDigest: 'a'.repeat(64) };
    const ownerReceipt = `urn:rezics:receipt:${randomUUID()}`;
    const structureReceipt = `urn:rezics:receipt:${randomUUID()}`;
    const structure = id(), revision = id();
    const calls: string[] = [];
    let ownerCommitted = false, structureCommitted = false;
    let loseOwnerResponse = true, loseStructureResponse = true;
    const steps = {
      createOwner: async (step: { owner: string; profile: typeof input.profile;
        idempotencyKey: string; requestDigest: string }) => {
        calls.push(step.idempotencyKey);
        ownerCommitted = true;
        if (loseOwnerResponse) {
          loseOwnerResponse = false;
          throw new Error('lost owner response after its receipt');
        }
        return { owner: step.owner, receipt: ownerReceipt,
          requestDigest: step.requestDigest, outcome: 'succeeded' as const };
      },
      createStructure: async (step: { owner: string; profile: typeof input.profile;
        idempotencyKey: string }) => {
        calls.push(step.idempotencyKey);
        expect(ownerCommitted).toBe(true);
        const replayed = structureCommitted;
        structureCommitted = true;
        if (loseStructureResponse) {
          loseStructureResponse = false;
          throw new Error('lost Structure response after its receipt');
        }
        return { owner: step.owner, structure, revision, receipt: structureReceipt,
          outcome: 'succeeded' as const, replayed };
      },
    };
    await expect(bootstrapStructureOwner(input, steps)).rejects.toThrow('lost owner response');
    expect(calls).toHaveLength(1);
    await expect(bootstrapStructureOwner(input, steps)).rejects.toThrow('lost Structure response');
    expect(calls).toHaveLength(3);
    const result = await bootstrapStructureOwner(input, steps);
    expect(result).toEqual({ owner: input.owner, structure, revision, ownerReceipt,
      structureReceipt, replayed: true });
    expect(calls[0]).toBe(calls[1]);
    expect(calls[1]).toBe(calls[3]);
    expect(calls[2]).toBe(calls[4]);
    expect(calls[0]).not.toBe(calls[2]);
    await expect(bootstrapStructureOwner({ ...input, profile: 'book-composition' }, steps))
      .rejects.toBeInstanceOf(StructureBootstrapConflict);
    await expect(bootstrapStructureOwner(input, { ...steps,
      createOwner: async step => ({ owner: step.owner, receipt: ownerReceipt,
        requestDigest: 'b'.repeat(64), outcome: 'succeeded' as const }) }))
      .rejects.toBeInstanceOf(StructureBootstrapConflict);
  });
