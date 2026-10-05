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

type MenuRole = 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';

/** Waits until exactly one element of the role is visible, pointer-ready and no longer animating, and returns it. */
async function findReady(scope: Scope, role: 'option' | MenuRole, name: string | RegExp, timeout: number): Promise<HTMLElement> {
  let ready!: HTMLElement;
  await waitFor(
    async () => {
      // A styled Select keeps a native <select> beside its popup; its <option>s are not the ones to click.
      const found = scope.queryAllByRole(role, { name, hidden: true }).filter((candidate: HTMLElement) => !candidate.closest('select'));
      await expect(found).toHaveLength(1);
      ready = found[0]!;
      await expect(ready).toBeVisible();
      await expect(getComputedStyle(ready).pointerEvents).not.toBe('none');
      await expect(entering(ready)).toHaveLength(0);
    },
    { timeout },
  );
  return ready;
}

/**
 * Clicks a combobox or listbox option once its popup accepts a pointer.
 * A popup's entrance transition keeps `pointer-events: none` on its options, so under load a story can find the
 * option, and user-event then refuses the click. Waits for the option to be visible, pointer-ready and no longer
 * animating before it clicks. Options are portalled, so pass `within(document.body)` or `screen` unless the list is inline.
 */
export async function chooseOption(scope: Scope, name: string | RegExp, { timeout = 4_000 } = {}): Promise<void> {
  await userEvent.click(await findReady(scope, 'option', name, timeout));
}

/**
 * Finds a menu item once its menu has finished opening, for a story that asserts on it or clicks it later.
 * Under load a menu item can exist while its popup is still entering, so a plain `findByRole` returns one that is not
 * yet visible or clickable.
 */
export function findMenuItem(scope: Scope, role: MenuRole, name: string | RegExp, { timeout = 4_000 } = {}): Promise<HTMLElement> {
  return findReady(scope, role, name, timeout);
}

/** Clicks a menu item (`menuitem`, `menuitemradio` or `menuitemcheckbox`) once its menu accepts a pointer; see `chooseOption`. */
export async function chooseMenuItem(scope: Scope, role: MenuRole, name: string | RegExp, { timeout = 4_000 } = {}): Promise<void> {
  await userEvent.click(await findReady(scope, role, name, timeout));
}
