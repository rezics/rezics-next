import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { studioHref } from '../features/studio/agent.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// A cook creates a recipe in Studio and writes it in the recipe editor: two ingredient sections that
// each hold "butter", a step that uses one of them, a stale edit from a second tab, a reload, and
// the published Work page. The browser signs in as the isolated QA stack's web member.

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const sessionStudio = (path = '') => {
  const { actingSubject } = fixture<{ actingSubject: string }>('REZICS_WEB_AUTH_PUBLIC_PATH');
  return `/en${studioHref({ iri: actingSubject, handle: null }, path)}`;
};

/** Ark paints the label over the native control, so the click has to land on the label. */
const choose = (control: Locator) => control.locator('xpath=ancestor::label[1]').click();

async function createRecipe(page: Page, title: string): Promise<string> {
  await page.goto(sessionStudio('/new'));
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await choose(page.getByRole('radio', { name: /^Recipe/ }));
  // A click before the page hydrates opens nothing: open it again until the list shows.
  const english = page.getByRole('option', { name: 'English', exact: true });
  await expect(async () => {
    if (!await english.isVisible()) await page.getByRole('combobox', { name: 'Language you’ll write in' }).click();
    await expect(english).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await english.click();
  await page.getByRole('button', { name: /^Create as / }).click();
  await page.waitForURL(/\/en\/w\/[1-9A-HJ-NP-Za-km-z]{22}\/edit\/recipe$/);
  return new URL(page.url()).pathname.replace(/\/edit\/recipe$/, '');
}

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** One screenshot per viewport, none with horizontal overflow: the files are what a reviewer reads. */
async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await overflows(page), `${name} ${label}`).toBe(false);
    await page.screenshot({ path: info.outputPath(`${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize(desktop);
}

/** Every field written so far has reached Main; the editor says so. */
const settled = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 30_000 });

const lines = (scope: Page | Locator) => scope.locator('[data-line]');
const steps = (scope: Page | Locator) => scope.locator('[data-step]');

async function addLine(page: Page, form: string, text: string) {
  const add = page.getByRole('form', { name: form });
  await add.getByRole('textbox', { name: 'Ingredient line' }).fill(text);
  await add.getByRole('textbox', { name: 'Ingredient line' }).press('Enter');
}

/** Opens the step's links and ticks the ingredient of the named section. */
async function linkStep(scope: Locator, section: string | null, ingredient: string) {
  await scope.getByRole('button', { name: /^Link ingredients|ingredients? linked$/ }).click();
  const picker = scope.getByRole('group', { name: 'Ingredients used' });
  const where = section ? picker.getByRole('group', { name: `In ${section}` }) : picker;
  await where.getByRole('checkbox', { name: ingredient }).check();
}

const started = Date.now();
/** Where the journey's time goes, printed as it runs. */
const mark = (label: string) => console.log(`[recipe-journey] ${Math.round((Date.now() - started) / 1000)}s ${label}`);

// A control that never appears fails in seconds, not at the end of the journey's budget.
test.use({ actionTimeout: 15_000 });

test('a cook writes a recipe with sections and linked steps, edits it from two tabs, publishes it and reads it back', async ({ page, context }, info) => {
  test.setTimeout(900_000);
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  await signInAtAccounts(page, sessionStudio(), member);
  await page.setViewportSize(desktop);
  const workPath = await createRecipe(page, 'Lemon muffins');
  mark('created');
  const editorPath = `${workPath}/edit/recipe`;
  await expect(page.getByRole('heading', { name: 'About this recipe' })).toBeVisible();
  mark('editor open');

  // Details: the title is the Work's own, so changing it renames the Work.
  const title = page.getByRole('textbox', { name: 'Title' });
  await title.fill('Lemon poppy muffins');
  await page.getByRole('textbox', { name: 'Description' }).fill('Bright and tender, with a little crunch.');
  await page.getByRole('textbox', { name: 'Notes' }).fill('Best the day after baking.');
  await page.getByRole('textbox', { name: 'Notes' }).blur();
  await settled(page);

  mark('details saved');
  // Yield and times.
  await page.getByRole('textbox', { name: 'Makes', exact: true }).fill('12');
  await page.getByRole('textbox', { name: 'What it makes' }).fill('muffins');
  await page.getByRole('textbox', { name: 'Servings' }).fill('12');
  await page.getByRole('textbox', { name: 'Prep time' }).fill('20');
  await page.getByRole('textbox', { name: 'Cook time' }).fill('25');
  await page.getByRole('textbox', { name: 'Total time' }).fill('45');
  await page.getByRole('textbox', { name: 'Total time' }).blur();
  await settled(page);

  mark('yield and times saved');
  // Two sections that each hold butter; a quantity written as "1½" keeps its written form.
  await page.getByRole('textbox', { name: 'Section name' }).fill('Cake');
  await page.getByRole('button', { name: 'Add section' }).click();
  const cake = page.getByRole('group', { name: 'Section Cake' });
  await expect(cake).toBeVisible();
  await addLine(page, 'Add an ingredient to Cake', '1½ cups flour, sifted');
  await expect(lines(cake)).toHaveText(['1 ½ cups flour, sifted']);
  await addLine(page, 'Add an ingredient to Cake', '200 g butter, softened');
  await expect(lines(cake)).toHaveText(['1 ½ cups flour, sifted', '200 g butter, softened']);
  await page.getByRole('form', { name: 'Add a section' }).getByRole('textbox', { name: 'Section name' }).fill('Icing');
  await page.getByRole('button', { name: 'Add section' }).click();
  const icing = page.getByRole('group', { name: 'Section Icing' });
  await expect(icing).toBeVisible();
  await addLine(page, 'Add an ingredient to Icing', '100 g butter');
  await expect(lines(icing)).toHaveText(['100 g butter']);
  mark('sections and lines written');
  // The line is read into parts that stay editable, and the edit keeps its place.
  await page.getByRole('button', { name: 'Edit 1 ½ cups flour, sifted' }).click();
  const edit = page.getByRole('form', { name: 'Edit 1 ½ cups flour, sifted' });
  await expect(edit.getByRole('textbox', { name: 'Amount' })).toHaveValue('1½');
  await expect(edit.getByRole('combobox', { name: 'Unit' })).toHaveValue('cups');
  await expect(edit.getByRole('textbox', { name: 'Ingredient', exact: true })).toHaveValue('flour');
  await expect(edit.getByRole('textbox', { name: 'Note' })).toHaveValue('sifted');
  await edit.getByRole('textbox', { name: 'Amount' }).fill('1 1/2');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(lines(cake)).toHaveText(['1 ½ cups flour, sifted', '200 g butter, softened']);

  mark('line edited');
  // Steps; the third uses the icing's butter, not the cake's.
  const addStep = async (text: string, section: string | null, ingredient: string | null) => {
    const form = page.getByRole('form', { name: 'Add a step' });
    await form.getByRole('textbox').fill(text);
    if (ingredient) await linkStep(form, section, ingredient);
    await form.getByRole('button', { name: 'Add', exact: true }).click();
  };
  await addStep('Cream the butter with the sugar.', 'Cake', '200 g butter, softened');
  await expect(steps(page)).toHaveCount(1);
  await addStep('Fold in the flour, spoon into a tin and bake for 25 minutes.', 'Cake', '1 ½ cups flour, sifted');
  await expect(steps(page)).toHaveCount(2);
  await addStep('Beat the icing butter until pale.', 'Icing', '100 g butter');
  await expect(steps(page)).toHaveCount(3);
  await expect(steps(page).nth(2).getByRole('button', { name: /1 ingredient linked/ })).toBeVisible();
  await expect(page.getByRole('article')).toContainText('Beat the icing butter until pale.');
  await shoot(page, 'recipe-editor', info);
  mark('steps written');

  mark('editor shots taken');
  // A second tab opened on the recipe as it is now.
  const other = await context.newPage();
  await other.setViewportSize(desktop);
  await other.goto(editorPath);
  await expect(steps(other)).toHaveCount(3);
  await expect(lines(other)).toHaveCount(3);

  mark('second tab open');
  // This tab moves the head: it adds a fourth step.
  await addStep('Ice the cooled muffins.', null, null);
  await expect(steps(page)).toHaveCount(4);

  // The other tab still holds the old head. Its edit is refused as stale, read again over the latest and written.
  await other.getByRole('button', { name: 'Edit 100 g butter' }).click();
  const stale = other.getByRole('form', { name: 'Edit 100 g butter' });
  await stale.getByRole('textbox', { name: 'Amount' }).fill('120');
  await stale.getByRole('button', { name: 'Save' }).click();
  await expect(lines(other).filter({ hasText: '120 g butter' })).toHaveCount(1);
  await expect(other.locator('[data-recipe-alert]')).toHaveCount(0);
  // Having read Main again, it shows the step the first tab added too.
  await expect(steps(other)).toHaveCount(4);
  await shoot(other, 'recipe-editor-after-stale-edit', info);
  await other.close();

  mark('stale edit settled');
  // After a reload everything is as written, with the links still on the right ingredients.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Lemon poppy muffins');
  await expect(lines(page.getByRole('group', { name: 'Section Cake' }))).toHaveText(['1 ½ cups flour, sifted', '200 g butter, softened']);
  await expect(lines(page.getByRole('group', { name: 'Section Icing' }))).toHaveText(['120 g butter']);
  await expect(steps(page)).toHaveCount(4);
  await expect(steps(page).nth(2).getByRole('button', { name: /1 ingredient linked/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Cook time' })).toHaveValue('25');
  await expect(page.getByRole('textbox', { name: 'Servings' })).toHaveValue('12');

  mark('reload checked');
  // Publish.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published. Everyone can read this recipe.')).toBeVisible();

  mark('published');
  // The Work page shows the recipe as written.
  await expect(async () => {
    await page.goto(workPath);
    await expect(page.getByRole('heading', { name: 'Lemon poppy muffins' }).first()).toBeVisible({ timeout: 5_000 });
    const recipe = page.getByRole('region', { name: 'Recipe', exact: true });
    // A section starts its own page, so the first response is the first heading. Continue until the
    // later section is here; the button's name changes while that part is loading.
    const more = recipe.getByRole('button', { name: 'Show more of this recipe' });
    for (let guard = 0; guard < 8 && await more.count(); guard += 1) {
      const before = await recipe.innerText();
      await more.click();
      await expect.poll(async () => {
        const text = await recipe.innerText();
        const loading = await recipe.getByRole('button', { name: 'Loading more…' }).count();
        return text !== before && loading === 0;
      }, { timeout: 15_000 }).toBe(true);
    }
    await expect(recipe).toContainText('Icing', { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  mark('work page loaded');
  const recipe = page.getByRole('region', { name: 'Recipe', exact: true });
  // The description reads under the title, ahead of the method; one Cook this; units as the cook wrote them.
  const description = page.getByText('Bright and tender, with a little crunch.');
  await expect(description).toBeVisible();
  expect((await description.boundingBox())!.y).toBeLessThan((await recipe.boundingBox())!.y);
  await expect(page.getByRole('button', { name: 'Cook this' })).toHaveCount(1);
  await expect(recipe.getByRole('radio', { name: 'As written' })).toBeChecked();
  await expect(recipe).toContainText('200 g butter, softened');
  await expect(recipe).toContainText('1 ½ cups flour, sifted');
  await expect(recipe).toContainText('120 g butter');
  await recipe.getByRole('radio', { name: 'US' }).click();
  await expect(recipe).toContainText('ounces butter');
  await recipe.getByRole('radio', { name: 'As written' }).click();
  await expect(recipe).toContainText('200 g butter, softened');
  await expect(recipe.getByRole('heading', { name: 'Cake' })).toBeVisible();
  await expect(recipe.getByRole('heading', { name: 'Icing' })).toBeVisible();
  await expect(recipe).toContainText('Yield 12 muffins');
  await expect(recipe).toContainText('Prep 20 min');
  await expect(recipe).toContainText('Cook 25 min');
  await expect(recipe).toContainText('Total 45 min');
  await expect(recipe.getByRole('list').last().getByRole('listitem')).toHaveCount(4);
  await expect(recipe).toContainText('Best the day after baking.');
  await expect(page.getByRole('link', { name: 'Edit recipe' })).toHaveAttribute('href', /\/edit\/recipe$/);
  await shoot(page, 'recipe-published', info);
});
