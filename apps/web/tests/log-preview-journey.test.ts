/** One browser outcome, mounted by the Long story's actual PageStory route composition. */
export async function logPreviewJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const { expect, userEvent, within } = await import('storybook/test');
  const { m } = await import('../src/paraglide/messages.js');
  const { longPublishedLogNote, myLogsStoryActivity } = await import('../src/kernel/fake/my-logs');
  const canvas = within(canvasElement);
  const list = await canvas.findByRole('list', { name: m.library_logs_heading() });
  const rows = within(list).getAllByRole('listitem');
  const first = rows[0]!;
  const second = rows[1]!;
  const note = first.querySelector<HTMLDetailsElement>('details')!;
  const otherNote = second.querySelector<HTMLDetailsElement>('details')!;
  const summary = note.querySelector('summary')!;
  const fullText = note.querySelector('p')!;
  const preview = summary.querySelector<HTMLElement>('[aria-hidden="true"]')!;
  const link = await within(first).findByRole('link', { name: /.+/ });
  const destination = link.getAttribute('href')!;
  const selectedId = decodeURIComponent(destination.split('/').at(-1)!);
  const reads = myLogsStoryActivity();

  await expect(longPublishedLogNote.length).toBe(1000);
  await expect(rows).toHaveLength(2);
  await expect(note.open).toBe(false);
  await expect(otherNote.open).toBe(false);
  await expect(fullText).not.toBeVisible();
  await expect(preview).toBeVisible();
  await expect(preview.getBoundingClientRect().height).toBeLessThanOrEqual(
    parseFloat(getComputedStyle(preview).lineHeight) * 3 + 1,
  );
  await expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth);
  await expect(reads.listReads).toBe(1);
  await expect(reads.detailReads).toBe(0);

  // Native disclosure remains keyboard accessible and belongs to its own keyed log row.
  summary.focus();
  await userEvent.keyboard('{Enter}');
  await expect(note.open).toBe(true);
  await expect(otherNote.open).toBe(false);
  await expect(preview).not.toBeVisible();
  await expect(fullText).toBeVisible();
  await expect(fullText.textContent).toBe(longPublishedLogNote);
  await expect(fullText.querySelector('em')).toBeNull();
  await expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth);

  await userEvent.click(otherNote.querySelector('summary')!);
  await expect(otherNote.open).toBe(true);
  await expect(note.open).toBe(true);
  await userEvent.click(summary);
  await expect(note.open).toBe(false);
  await expect(otherNote.open).toBe(true);
  await expect(myLogsStoryActivity()).toEqual(reads);
  await expect(link.getAttribute('href')).toBe(destination);

  // Follow the real selected-log reader and its existing owner publication controls.
  await userEvent.click(link);
  await canvas.findByRole('heading', { name: m.library_logs_page_heading() });
  const noteHeading = await canvas.findByRole('heading', { name: m.library_logs_note() });
  await expect(noteHeading.nextElementSibling?.textContent).toBe(longPublishedLogNote);
  const remove = await canvas.findByRole('button', { name: m.library_logs_delete() });
  await userEvent.click(remove);
  await expect(await canvas.findByRole('button', { name: m.library_logs_confirm_delete() })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.library_logs_cancel() }));
  await expect(canvas.getByRole('button', { name: m.library_logs_delete() })).toBeVisible();
  await expect(myLogsStoryActivity()).toEqual({ listReads: reads.listReads, detailReads: 1, detailId: selectedId });

  // Leave the canonical long story on its original, collapsed list for subsequent review.
  const back = await canvas.findByRole('link', { name: m.library_logs_back() });
  await expect(back.getAttribute('href')).toMatch(/\/library\/logs$/);
  await expect(back.getAttribute('href')).not.toContain('cursor=');
  await userEvent.click(back);
  await canvas.findByRole('heading', { name: m.library_my_logs_heading() });
  const restoredList = await canvas.findByRole('list', { name: m.library_logs_heading() });
  await expect(restoredList.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
}
