import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'books/read-non-ui-languages-non-ui-languages',
  {
    visitor: proved(
      'reads published Swedish text, recorded language and its original author credit',
    ),
    stranger: proved(
      'reads published Swedish text, recorded language and its original author credit',
    ),
    member: proved(
      'reads published Swedish text, recorded language and its original author credit',
    ),
    owner: proved('reads published Swedish text and credit and retains authorized private reading'),
    moderator: proved('reads Swedish text and credit without gaining a private Work grant'),
    operator: proved('reads Swedish text and credit without gaining a private Work grant'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original Swedish fixture text by Outcome owner, explicitly credited as the native Work and contribution author.',
    },
  },
);
