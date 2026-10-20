# How work is defined, proved and landed

The [brief validator](../../scripts/goal/briefs.ts),
[task lifecycle](../../scripts/goal/tasks.ts) and [merge gate](../../scripts/goal/merge.ts)
carry the executable rules. Managers apply a required check manually until the
tool implements it, and name that check in the brief.

## The unit of work is an outcome row

A Goal's scope is a fixed list of rows in the scope registry
(`scripts/qa/cases/launch-coverage.ts`). A row is one capability, stated for
people: who does what, and what each kind of person then gets from the API.

Every row carries an outcome for each persona, or says why one does not apply:

| Persona | Asked of every row |
| --- | --- |
| Signed-out visitor | What the public API returns |
| Signed-in person with no relation to the resource | The same, plus what they may not do |
| Member or follower | What membership adds |
| Author or owner | What only they see or may change |
| Moderator of the Realm | What moderation adds |
| Platform operator | What platform authority adds |

Rows that publish content also state the rights basis the content is published
under and who is credited.

A finding outside the rows goes to the Goal's later list. The supermanager
promotes it into scope only when a row's stated outcome fails for one of its
personas. "It is a defect" is not a reason; "this person cannot do what the row
says" is.

## API first: three tasks for a row

1. Outcome. The API operations and one outcome test for each persona, run
   through the public API of a real stack, with none of our own modules mocked.
   Written before the implementation by a worker that will not write the
   implementation, and shown to fail on `main` for the stated reason. The
   manager reads the matrix as a product owner: is this what each person should
   get? A wrong answer here costs a paragraph.
2. Implementation. Makes those tests pass. It does not edit them; a needed
   change goes back to the manager and into the brief first. Done means the
   row's outcome tests, the unit gate and the repository guards pass.
3. Surface. The web consumes the operation through the typed client and
   shows each state the operation's contract can answer as a story fed by
   answers recorded from the row's outcome tests: loading and populated always;
   empty, error and pending where the contract admits them (pending is a `202`
   and nothing else, so a read that answers only `200` or a problem has no
   pending story). Keep recorded API answers unchanged. UI interaction stories
   may use clearly identified contract-shaped fixtures and failure injection;
   a new backend state still needs its API outcome proof. Its gate is types,
   unit tests and stories. Passing Storybook browser interactions establish
   the UI criteria, combined with API evidence for server behavior. Do not
   repeat a full backend journey for every UI viewport or locale. One browser
   journey per vertical runs in the program's nightly regression, not one per row.
   A request the page sends that the row's record lacks is recorded by the
   surface task itself. The surface task claims the row's outcome test and
   record, imports the production client, changes no assertion and no cell,
   and runs the answer-records guard. A separate record task is briefed only
   for a row that no surface task holds.

A row is proved when its outcome tests pass on the shared stack. The surface
follows a proved row and never leads it.

Open work runs in [waves](wave.md). A build phase
implements on one shared branch and starts no stack. A prove phase runs the
whole suite and fixes what fails. The order above still holds inside a wave:
each row's outcome test is the specification. Tests run once per wave rather than once per task.

## What blocks a landing

The landing gate blocks on:

- an outcome test that fails, is skipped, weakened or edited by the
  implementation task;
- a failing gate (types, unit tests, guards);
- a reviewer's finding that arrives with a test, through the public API, that
  fails on the branch and shows a persona reading or changing what its row
  refuses, or data lost or corrupted.

Nothing else blocks. A race counts when a test reproduces it. Everything else a
reviewer notes is recorded for the later list.

Review is one pass, and only for implementation tasks that change authority,
disclosure, rights, erasure or Account code. Outcome and surface tasks land on
their gates.

A task gets two fix rounds after its first handoff. Then it stops, and the
manager chooses in writing, in the brief: cut the row's scope, split the task,
or write a design note. `goalctl` refuses a further resume without that entry.

## Shared mechanisms

A change to a mechanism other rows build on (`scripts/static/mechanisms.ts`):

- starts from a one-page design note in the brief, read by its Goal's manager
  before code: which readers and writers it touches and how each still passes.
  The [brief validator](../../scripts/goal/tasks.ts) defines the review marker;
- states the observable outcome ("reads per request do not depend on the number
  of matches"), rather than prescribing a second mechanism;
- lands with a test on the real composition (`composeMain`), not on a double;
- has one open task at a time for each mechanism.

## Briefs

A brief names the row, its outcome tests, the files likely to change and what
not to build, in forty lines or fewer. Expect more than about 400 changed lines
or eight files and it is two tasks, cut along file boundaries. A chain of steps
in the same files goes to one worker as an ordered list, not to several.

## Measures

`goalctl status` reports them and every checkpoint reads them:

| Measure | Reading |
| --- | --- |
| Rows proved of rows in scope | The only progress figure |
| First-attempt share of attempts | Below half: class the day's fix rounds by cause and remove the commonest; dispatch goes on |
| Attempts for each landed task | Median two or fewer; three is the cap |
| Tokens for each proved row | Compared between Goals and weeks |
| Findings that blocked, by kind | Anything but the three kinds above is a tool defect |
