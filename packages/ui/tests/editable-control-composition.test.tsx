import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityPicker, type EntityPickerSubject } from '../src/components/entity-picker.tsx';
import { LocaleProvider } from '../src/components/locale.tsx';
import { Button } from '../src/shadcn/button.tsx';
import { Input } from '../src/shadcn/input.tsx';
import { Textarea } from '../src/shadcn/textarea.tsx';

test('Empty editable fields and entity selection stay visible and usable on phones', () => {
  const subject: EntityPickerSubject = {
    id: 'urn:rezics:0192f3a1-7c1e-7b52-9d34-aa01',
    title: 'An extraordinarily long translated title for the selected edition of a collected work',
    types: ['creative-work'],
    typeLabel: 'Collected edition',
    year: 2024,
    cover: null,
  };
  // Render the real default composition, including the native Base UI input and
  // the selected subject absent from the current search results. No primitive mocks.
  for (const theme of ['light', 'dark']) {
    for (const multiple of [false, true]) {
      for (const disabled of [false, true]) {
        const html = renderToStaticMarkup(
          <LocaleProvider locale="en">
            <form className={theme}>
              <label htmlFor="name">Collection name</label>
              <Input id="name" />
              <label htmlFor="description">Description</label>
              <Textarea id="description" />
              <EntityPicker
                label="Subject"
                search={async () => []}
                src={() => ''}
                defaultValue={[subject]}
                multiple={multiple}
                disabled={disabled}
              />
              <Button type="submit">Save</Button>
            </form>
          </LocaleProvider>,
        );
        expect(html).toContain('id="name"');
        expect(html).toMatch(/<textarea[^>]*id="description"[^>]*><\/textarea>/);
        const input = (html.match(/<input\b[^>]*>/g) ?? []).find((tag) => tag.includes('role="combobox"'));
        expect(input).toBeDefined();
        expect(input).toContain('aria-label="Subject"');
        expect(input!.includes('disabled=""')).toBe(disabled);
        expect(input).toContain(`value="${multiple ? '' : subject.title}"`);
        if (multiple) {
          expect(html).toContain('aria-label="Selected"');
          expect(html).toContain(subject.title);
          expect(html).toContain(subject.typeLabel);
          const remove = (html.match(/<button\b[^>]*>/g) ?? []).find((tag) => tag.includes('aria-label="Remove '));
          expect(remove).toContain(`aria-label="Remove ${subject.title}"`);
          expect(remove!.includes('disabled=""')).toBe(disabled);
        }
        expect(html).not.toContain(subject.id);
        expect(html).toContain('type="submit"');
      }
    }
  }
});
