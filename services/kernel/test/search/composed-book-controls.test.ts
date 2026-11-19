import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { bookBindingStep } from '../../src/request/book-binding-steps.ts';
import { Admission } from '../../src/http/admission.ts';
import {
  composedBookControl,
  runBookCatalogueRead,
  runComposedPageReads,
} from '../../src/search/composed-book-reads.ts';
import type { ControlPhase, PageControl } from '../../src/search/book-page-controls.ts';

test('parked Book controls skip unused phases, isolate misses and serialize competing observations', async () => {
  const pool = {} as Pool;
  const admission = new Admission({ permits: 1, reserved: 1, queue: 4 });
  const job = { deadline: Date.now() + 5_000 };
  const submitted: [ControlPhase, unknown[]][] = [];
  const completed: string[] = [];
  const participants = ['one', 'two', 'missing', 'refused', 'ordinary'];
  await runComposedPageReads(
    participants,
    async (id) => {
      await runBookCatalogueRead(admission, job, async () => {
        if (id === 'ordinary') return;
        const control = (phase: ControlPhase): PageControl => ({
          pool,
          id,
          page: id,
          deadline: job.deadline,
          phase,
          observation: id === 'two' ? 'one' : id,
          fund() {
            if (id === 'refused') throw new Error('unfunded');
            return [id];
          },
          async submit(_text, values, receive) {
            submitted.push([phase, values]);
            receive(
              values
                .filter((v) => v !== 'missing')
                .reverse()
                .map((v) => ({ id: String(v) })),
            );
          },
          receive(rows) {
            expect(rows.map((row) => row.id)).toEqual(id === 'missing' ? [] : [id]);
          },
        });
        const planned = composedBookControl(control('plan'));
        expect(planned).toBeDefined();
        if (id === 'refused') {
          await expect(planned!).rejects.toThrow('unfunded');
          return;
        }
        if (!(await planned)) return;
        if (id === 'one') {
          expect((await composedBookControl(control('reserve')))?.id).toBe(id);
          expect(composedBookControl(control('reserve'))).toBeUndefined();
        }
        expect((await composedBookControl(control('seal')))?.id).toBe(id);
        completed.push(id);
      });
    },
    () => {},
  );
  expect(completed.sort()).toEqual(['one', 'two']);
  expect(submitted).toEqual([
    ['plan', ['one', 'missing']],
    ['plan', ['two']],
    ['reserve', ['one']],
    ['seal', ['one']],
    ['seal', ['two']],
  ]);
  expect(admission.running.normal).toBe(0);
});

test('Book references keep their own tokens across targets and competing observations with one permit', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 4 });
  const job = { deadline: Date.now() + 5000 };
  const tokens = ['a', 'b', 'c', 'd'];
  const groups: string[][] = [];
  const owner = {};
  await runComposedPageReads(
    tokens,
    async (token) => {
      await runBookCatalogueRead(admission, job, async () => {
        const observation = token === 'c' ? 'a' : token;
        const held = await bookBindingStep(
          'reference',
          owner,
          token === 'd' ? 'other' : 'books',
          observation,
          job.deadline,
          token,
          async (members) => {
            groups.push([...members]);
            return members.map((member) => (member === 'b' ? null : member));
          },
        );
        expect(held).toBe(token === 'b' ? null : token);
      });
    },
    () => {},
  );
  expect(groups).toEqual([['a', 'b'], ['c'], ['d']]);
  expect(admission.running.normal).toBe(0);
});
