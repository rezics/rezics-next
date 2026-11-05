/** Fixed closed bounds for the automated-creation operator advice page.
 * Labels are measured in UTF-16 code units. The byte allowance covers JSON
 * syntax, ASCII UUID/handle values, and worst-case six-byte escaping for names.
 */
export const AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH = 36;
export const AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH = 64;
export const AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH = 4096;

const handleRules = {
  minLength: 3,
  maxLength: 64,
  normalization: 'lowercase',
  pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
};

function page(readiness: string, action: string, operator: unknown) {
  return { viewer: { accountId: '' }, readiness, operator, handleRules, action };
}

const reviewedOperator = { id: '', kind: 'organization', handle: '', displayName: '' };
const variants = [
  page('authentication-needed', 'authenticate', null),
  page('select-operator', 'select-operator', null),
  page('review', 'confirm', reviewedOperator),
  page('refused', 'none', null),
];

/** Every legal readiness/action pair is included. Null operator/label forms are
 * shorter than their string maxima; the non-review null operator variants are
 * represented directly. The JSON skeleton includes keys, punctuation and the
 * quotes around each variable string. */
export const AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES = Math.max(
  ...variants.map((value) => {
    const hasOperator = value.operator !== null;
    const asciiUnits =
      AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH +
      (hasOperator ? AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH + AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH : 0);
    const escapableUnits = hasOperator ? AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH : 0;
    // These ASCII skeletons have equal UTF-8 byte and UTF-16 lengths.
    return JSON.stringify(value).length + asciiUnits + escapableUnits * 6;
  }),
);
