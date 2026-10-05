import { expect, userEvent, waitFor, type within } from 'storybook/test';

type Scope = ReturnType<typeof within>;

/** Animations still running on the option or any popup around it. */
function entering(option: HTMLElement): Animation[] {
  return option.ownerDocument
    .getAnimations()
    .filter(({ effect, playState }) => {
      const target = effect instanceof KeyframeEffect ? effect.target : null;
      return playState !== 'finished' && playState !== 'idle' && target?.contains(option) === true;
    });
}

/**
 * Clicks a combobox or listbox option once its popup accepts a pointer.
 * A popup's entrance transition keeps `pointer-events: none` on its options, so under load a story can find the
 * option, and user-event then refuses the click. Waits for the option to be visible, pointer-ready and no longer
 * animating before it clicks. Options are portalled, so pass `within(document.body)` or `screen` unless the list is inline.
 */
export async function chooseOption(scope: Scope, name: string | RegExp, { timeout = 4_000 } = {}): Promise<void> {
  let option!: HTMLElement;
  await waitFor(
    async () => {
      // A styled Select keeps a native <select> beside its popup; its <option>s are not the ones to click.
      const found = scope.queryAllByRole('option', { name, hidden: true }).filter((candidate: HTMLElement) => !candidate.closest('select'));
      await expect(found).toHaveLength(1);
      option = found[0]!;
      await expect(option).toBeVisible();
      await expect(getComputedStyle(option).pointerEvents).not.toBe('none');
      await expect(entering(option)).toHaveLength(0);
    },
    { timeout },
  );
  await userEvent.click(option);
}
