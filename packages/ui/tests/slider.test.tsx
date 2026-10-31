import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Slider } from '../src/shadcn/slider.tsx';

const slot = (html: string, name: string) => html.match(new RegExp(`<[^>]+data-slot="${name}"[^>]*>`))?.[0] ?? '';
const inputs = (html: string) => (html.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes('type="range"'));

test('thumb props name the nested native range input without leaking onto the root', () => {
  const html = renderToStaticMarkup(
    <Slider
      defaultValue={[40]}
      className="root-marker"
      thumbProps={{ 'aria-label': 'Rating', 'aria-valuetext': '40 points', className: 'thumb-marker' }}
    />,
  );
  expect(inputs(html)).toHaveLength(1);
  expect(inputs(html)[0]).toContain('aria-label="Rating"');
  expect(inputs(html)[0]).toContain('aria-valuetext="40 points"');
  const root = slot(html, 'slider');
  expect(root).toContain('root-marker');
  expect(root).not.toMatch(/thumbProps|thumb-marker|aria-label=|aria-valuetext=/);
  const thumb = slot(html, 'slider-thumb');
  for (const name of ['thumb-marker', 'size-4', 'focus-visible:ring-4', 'disabled:opacity-50'])
    expect(thumb).toContain(name);
});

test('typed getters and state class names reach the actual thumb and input', () => {
  const html = renderToStaticMarkup(
    <Slider
      value={[6]}
      min={1}
      max={10}
      step={0.5}
      name="rating"
      disabled
      thumbProps={{
        'aria-label': 'Fallback',
        'aria-valuetext': 'Fallback value',
        getAriaLabel: (index) => `Rating ${index + 1}`,
        getAriaValueText: (_formatted, value, index) => `${value} points on scale ${index + 1}`,
        className: (state) => state.disabled ? 'disabled-thumb' : 'enabled-thumb',
      }}
    />,
  );
  const input = inputs(html)[0] ?? '';
  for (const attribute of ['aria-label="Rating 1"', 'aria-valuetext="6 points on scale 1"', 'min="1"', 'max="10"', 'step="0.5"', 'name="rating"', 'value="6"', 'disabled=""'])
    expect(input).toContain(attribute);
  expect(slot(html, 'slider-thumb')).toContain('disabled-thumb');
  expect(slot(html, 'slider-thumb')).toContain('focus-visible:ring-4');
  expect(slot(html, 'slider')).not.toMatch(/getAria|thumbProps|disabled-thumb|aria-valuetext=/);
});

test('optional thumb props preserve existing default, controlled and multi-thumb counts', () => {
  for (const props of [{}, { defaultValue: [30] }, { defaultValue: [20, 70] }, { value: [10, 30, 80] }]) {
    const expected = 'value' in props ? 3 : props.defaultValue?.length ?? 2;
    const html = renderToStaticMarkup(<Slider {...props} />);
    expect(inputs(html)).toHaveLength(expected);
    const named = renderToStaticMarkup(<Slider {...props} thumbProps={{ 'aria-label': 'Rating' }} />);
    expect(inputs(named)).toHaveLength(expected);
    for (const input of inputs(named)) expect(input).toContain('aria-label="Rating"');
  }
});
