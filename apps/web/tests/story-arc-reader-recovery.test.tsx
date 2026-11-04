import { expect, test } from 'bun:test';
import { act } from 'react';
import { ui } from './story-arc-reader-view.test';
import { arcAddress, arcExample, arcId, characterId } from '../src/features/catalogue/story-arc-reader/examples';
import type { ArcAddress, ArcRead, ArcTransport } from '../src/features/catalogue/story-arc-reader/model';
import { m } from '../src/paraglide/messages.js';

type Ready = Extract<ArcRead, { ok: true }>;
const admitted = (read: ArcRead): Ready => {
  if (!read.ok) throw new Error('Expected admitted native example');
  return read;
};
const button = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find((node) => node.textContent?.trim().startsWith(label))!;
const child = (scope: ParentNode) => scope.querySelector<HTMLElement>('[data-slot=arc-appearance-window]')!;

test('Previous keeps eight accepted addresses, rereads them, evicts oldest, and Start clears the trail', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = admitted(await fixture.read());
    const addresses: ArcAddress[] = [];
    const transport: ArcTransport = async (address) => {
      addresses.push({ ...address });
      const number = address.cursor?.startsWith('page:') ? Number(address.cursor.slice(5)) : 1;
      return { ...initial, next: `page:${number + 1}` };
    };
    await mounted.render({ ...arcAddress, locale: 'en', source: {}, reader: null, initial, transport });
    // The first native frontier remains exact; following pages use authored opaque tokens.
    await mounted.click(m.work_parts_more());
    for (let i = 0; i < 9; i++) await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.arc_reader_history_limit());
    for (let i = 0; i < 8; i++) await mounted.click(m.arc_reader_previous());
    expect(button(mounted.host, m.arc_reader_previous()).disabled).toBe(true);
    expect(addresses.at(-1)?.cursor).toBe('page:2');
    await mounted.click(m.work_parts_restart());
    expect(addresses.at(-1)).toEqual({ ...arcAddress, stream: initial.stream!.key });
    expect(button(mounted.host, m.arc_reader_previous()).disabled).toBe(true);
    expect(mounted.host.textContent).not.toContain(m.arc_reader_history_limit());
  } finally {
    await mounted.close();
  }
});

test('failed frontier is distinct from prior page; exact Retry, Previous, Start and fresh discovery remain deliberate', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = admitted(await fixture.read());
    const addresses: ArcAddress[] = [];
    let failure: 'unavailable' | 'withheld' | 'invalid' | undefined;
    const transport: ArcTransport = async (address) => {
      addresses.push({ ...address });
      return failure
        ? { ok: false, reason: failure }
        : { ...initial, next: address.cursor ? 'frontier-2' : initial.next };
    };
    await mounted.render({ ...arcAddress, locale: 'en', source: {}, reader: null, initial, transport });
    await mounted.click(m.work_parts_more());
    failure = 'unavailable';
    await mounted.click(m.work_parts_more());
    const failed = addresses.at(-1);
    expect(mounted.host.textContent).toContain(m.arc_reader_prior_page());
    expect(mounted.host.textContent).toContain('frontier-2');
    expect(mounted.host.textContent).toContain('Later title');
    expect(button(mounted.host, m.arc_reader_previous()).disabled).toBe(false);
    expect(button(mounted.host, m.work_parts_restart()).disabled).toBe(false);
    await mounted.click(m.subject_section_retry());
    expect(addresses.at(-1)).toEqual(failed);
    failure = undefined;
    await mounted.click(m.arc_reader_previous());
    expect(addresses.at(-1)?.cursor).toBeUndefined();
    failure = 'withheld';
    await mounted.click(m.work_parts_more());
    expect(mounted.host.querySelectorAll('[data-slot=story-arc-row]')).toHaveLength(0);
    expect(mounted.host.textContent).not.toContain('Later title');
    expect(mounted.host.querySelectorAll('a')).toHaveLength(1);
    failure = 'invalid';
    await mounted.click(m.subject_section_retry());
    expect(mounted.host.textContent).toContain(m.arc_reader_invalid());
    failure = undefined;
    await mounted.click(m.arc_reader_discover());
    expect(addresses.at(-1)).toEqual(arcAddress);
    expect(mounted.host.textContent).toContain('Later title');
    expect(mounted.host.textContent).not.toContain(m.arc_reader_prior_page());
  } finally {
    await mounted.close();
  }
});

test('member excursion preserves parent assertion and exact arc filter through Previous, Retry, Start and fresh recovery', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = admitted(await fixture.read());
    const addresses: ArcAddress[] = [];
    let failure = false;
    const transport: ArcTransport = async (address) => {
      addresses.push({ ...address });
      if (failure) return { ok: false, reason: 'invalid' };
      const page = admitted(await fixture.read(address));
      return { ...page, next: address.cursor ? null : 'child-next' };
    };
    await mounted.render({ ...arcAddress, locale: 'en', realm: 'realm', source: {}, reader: null, initial, transport });
    const opener = await mounted.click(m.arc_reader_characters());
    expect(document.activeElement?.tagName).toBe('H4');
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    // Parent inspection follows the exact inverse membership holder, not the character assertion.
    const inspection = mounted.host.querySelector('section[aria-label="' + m.arc_reader_inspect() + '"]')!;
    expect(inspection.textContent).toContain(initial.rows[0]!.holder);
    expect(inspection.textContent).toContain(initial.rows[0]!.statementId);
    await mounted.click(m.subject_spoiler_show(), child(mounted.host));
    await mounted.click(m.arc_reader_inspect(), child(mounted.host));
    expect(child(mounted.host).textContent).toContain('原典の範囲');
    const target = child(mounted.host).querySelector<HTMLAnchorElement>(`a[href*="${characterId}"]`)!;
    expect(target.target).toBe('_blank');
    expect(target.href).toContain('/en/');
    expect(target.href).toContain('realm');
    await mounted.click(m.work_parts_more(), child(mounted.host));
    expect(child(mounted.host).textContent).not.toContain('Secret character');
    await mounted.click(m.arc_reader_previous(), child(mounted.host));
    expect(addresses.at(-1)?.cursor).toBeUndefined();
    failure = true;
    await mounted.click(m.work_parts_more(), child(mounted.host));
    const failed = addresses.at(-1);
    expect(child(mounted.host).querySelectorAll('a')).toHaveLength(1);
    await mounted.click(m.subject_section_retry(), child(mounted.host));
    expect(addresses.at(-1)).toEqual(failed);
    failure = false;
    await mounted.click(m.arc_reader_discover(), child(mounted.host));
    expect(addresses.at(-1)?.stream).toBeUndefined();
    await mounted.click(m.work_parts_restart(), child(mounted.host));
    expect(addresses.every((address) => address.arc === arcId)).toBe(true);
    expect(addresses.at(-1)?.stream).toBe('forward:schema:character');
    await mounted.click(m.arc_reader_back());
    expect(document.activeElement).toBe(opener);
    expect(child(mounted.host)).toBeNull();
    expect(mounted.host.textContent).toContain(initial.rows[0]!.statementId);
  } finally {
    await mounted.close();
  }
});

test('pointer opening and late child reads never steal focus or replace a new child, equal outer success retires selection and reveal', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = admitted(await fixture.read());
    let settle: ((value: ArcRead) => void) | undefined;
    let defer = true;
    const transport: ArcTransport = (address) =>
      address.arc && defer
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : fixture.read(address);
    const props = { ...arcAddress, locale: 'en', source: {}, reader: null, initial, transport };
    await mounted.render(props);
    const opener = await mounted.click(m.arc_reader_characters(), mounted.host, 1);
    expect(document.activeElement).toBe(opener);
    const priorClose = button(mounted.host, m.arc_reader_back());
    await mounted.click(m.arc_reader_back());
    defer = false;
    await mounted.click(m.arc_reader_characters());
    const currentChild = child(mounted.host);
    const different = button(mounted.host, m.work_parts_restart());
    different.focus();
    await act(async () => {
      settle?.(await fixture.read({ ...arcAddress, id: initial.rows[0]!.holder, arc: arcId }));
      priorClose.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new Event('focus'));
    });
    expect(child(mounted.host)).toBe(currentChild);
    expect(document.activeElement).toBe(different);
    await mounted.click(m.arc_reader_back());
    await mounted.click(m.subject_spoiler_show());
    expect(mounted.host.textContent).toContain('Earlier title');
    await mounted.click(m.work_parts_restart());
    expect(mounted.host.textContent).not.toContain('Earlier title');
    expect(mounted.host.querySelector('section[aria-label="' + m.arc_reader_inspect() + '"]')).toBeNull();
    await mounted.click(m.arc_reader_characters());
    expect(child(mounted.host)).not.toBeNull();
    const sequence = initial.streams.find((stream) => stream.kind === 'sequence')!;
    await mounted.click(sequence.label.text);
    expect(child(mounted.host)).toBeNull();
  } finally {
    await mounted.close();
  }
});

test('equal-success browser replacement and departure retire the entire reading; a matching payload cannot revive it', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = admitted(await fixture.read());
    const props = { ...arcAddress, locale: 'en', source: {}, reader: null, initial, transport: fixture.read };
    await mounted.render(props);
    await mounted.click(m.arc_reader_characters());
    await act(async () => mounted.client.setQueryData(['session'], { state: 'signed-out' }));
    expect(child(mounted.host)).toBeNull();
    expect(mounted.host.querySelectorAll('button')).toHaveLength(0);
    expect(mounted.host.textContent).toContain(m.arc_reader_fresh_subject());
    await mounted.render(props);
    expect(mounted.host.querySelectorAll('button')).toHaveLength(0);
    await mounted.render({ ...props, source: {} });
    expect(mounted.host.textContent).toContain('Later title');
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(mounted.host.querySelectorAll('button')).toHaveLength(0);
    await mounted.render({ ...props, source: {} });
    expect(mounted.host.textContent).toContain('Later title');
  } finally {
    await mounted.close();
  }
});
