import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Slider } from '../src/shadcn/slider.tsx';
import { RatingInput } from '../src/components/rating.tsx';

const slot = (html: string, name: string) => html.match(new RegExp(`<[^>]+data-slot="${name}"[^>]*>`))?.[0] ?? '';
const inputs = (html: string) => (html.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes('type="range"'));

test('supported label and number formatting reach the nested native range', () => {
  const html = renderToStaticMarkup(
    <>
      <span id="rating-label">Rating</span>
      <Slider
        defaultValue={[40]}
        className="root-marker"
        name="rating"
        aria-labelledby="rating-label"
        locale="en"
        format={{ minimumFractionDigits: 1 }}
      />
    </>,
  );
  expect(inputs(html)).toHaveLength(1);
  expect(inputs(html)[0]).toContain('aria-labelledby="rating-label"');
  expect(inputs(html)[0]).toContain('name="rating"');
  expect(inputs(html)[0]).toContain('aria-valuetext="40.0"');
  const root = slot(html, 'slider');
  expect(root).toContain('root-marker');
  expect(root).not.toMatch(/aria-valuetext=/);
  const thumb = slot(html, 'slider-thumb');
  for (const name of ['size-4', 'focus-visible:ring-4', 'disabled:opacity-50']) expect(thumb).toContain(name);
});

test.each([
  { value: 12, text: '6 out of 10', rangeValue: 6 },
  { value: null, text: 'Not rated', rangeValue: 5.5 },
])(
  'the actual rating input keeps its label, formatted value, scale and disabled state: %j',
  ({ value, text, rangeValue }) => {
    const html = renderToStaticMarkup(
      <RatingInput
        value={value}
        scale={{ minimum: 2, maximum: 20, unitsPerPoint: 2 }}
        locale="en"
        labels={{ label: 'How much did you like it?' }}
        disabled
        onChange={async () => {}}
      />,
    );
    const ranges = inputs(html);
    expect(ranges).toHaveLength(1);
    const input = ranges[0]!;
    const labelIds = input.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(' ') ?? [];
    expect(labelIds.length).toBeGreaterThan(0);
    expect(html).toMatch(new RegExp(`<span[^>]+id="${labelIds[0]}"[^>]*>How much did you like it\\?</span>`));
    for (const attribute of [
      `aria-valuetext="${text}"`,
      `value="${rangeValue}"`,
      'min="1"',
      'max="10"',
      'step="0.5"',
      'disabled=""',
    ])
      expect(input).toContain(attribute);
    expect(slot(html, 'slider-thumb')).not.toMatch(/aria-valuetext=|aria-labelledby=/);
    expect(slot(html, 'slider')).not.toMatch(/aria-valuetext=/);
  },
);

test('supported labels preserve default, controlled and multi-thumb counts', () => {
  for (const props of [{}, { defaultValue: [30] }, { defaultValue: [20, 70] }, { value: [10, 30, 80] }]) {
    const expected = 'value' in props ? 3 : (props.defaultValue?.length ?? 2);
    expect(inputs(renderToStaticMarkup(<Slider {...props} />))).toHaveLength(expected);
    const named = renderToStaticMarkup(<Slider {...props} aria-labelledby="rating-label" />);
    expect(inputs(named)).toHaveLength(expected);
    for (const input of inputs(named)) expect(input).toContain('aria-labelledby="rating-label"');
  }
});
