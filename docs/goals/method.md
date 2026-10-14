# How work is defined, proved and landed

Status: designed on 2026-10-12 at the maintainer's request, from that day's
measurements. Since 2026-10-13 `goalctl` enforces the brief kinds, the landing
rules and the attempt cap; the [program](program/GOAL.md#next-tasks) builds the
rest. Until a check exists in code, managers apply it by hand and say so in the
brief.

## Why

On 2026-10-12 three Goals ran about 25 workers for ten hours. 77 tasks closed and
the scope registry did not move for the last three hours. Measured from the run
logs of that day:

| Measure | Value |
| --- | --- |
| Worker attempts | 502: 101 first attempts, 377 resumes after a review, a gate or a rebase, 24 capacity retries |
| Worker output from first attempts | 7% (59% came from a task's fifth or later attempt) |
| Landing reviews | 245, of which 171 returned blocking findings; 505 reviewer passes |
| Findings | 813: 644 P2; 296 anchored in tests, fixtures or scripts; 149 in the web; 245 need a specific interleaving |
| Worker output by Goal | Launch (web and launch-facing API) 53%, Kernel 31%, Trust-ops 14% |

What the figures showed:

- **Done was defined after the fact and without a limit.** A task was done when
  an adversarial reviewer found nothing in its diff. One pass finds a small part
  of what the next pass would find, so every round returned something, mostly
  about tests and hypothetical interleavings, and every finding cost a resume.
- **Plain outcomes were never asked.** The Gutenberg recipes were "proved" by the
  importing author's own view; no test asked what another reader sees or under
  which rights basis the text was published. A private Realm's member could not
  read its decisions for the same reason: the proof had one persona.
- **The web was verified like the kernel**, with the same review and a browser
  proof for each row, although it only consumes the API.
- **Shared mechanisms were designed inside tasks.** A contract landed with test
  doubles as its only implementations and made public reads unavailable for two
  and a half hours; a fence that replayed whole reads multiplied one reader's
  queries by five and no test noticed. About a dozen tasks existed only to undo
  or patch another landing.
- **Rules in documents did not hold.** "Stop after three attempts" was written
  on 2026-10-11; tasks took 9, 12 and 31 attempts the next day, each exception
  granted in a mail.

Published evidence agrees where it exists: a finding should block only when it
names a violated acceptance criterion or comes with a reproducible failure;
acceptance checks stated before the work lower its cost; agents over-mock their
own tests, and almost half of their merged fixes change behaviour on inputs
their tests never reach; adding coordinating agents does not raise success, and
failures sit on the seams between owners. The sources are in the report this page
was written from, archived with the 2026-10-12 Goals.

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

1. **Outcome.** The API operations and one outcome test for each persona, run
   through the public API of a real stack, with none of our own modules mocked.
   Written before the implementation by a worker that will not write the
   implementation, and shown to fail on `main` for the stated reason. The
   manager reads the matrix as a product owner: is this what each person should
   get? A wrong answer here costs a paragraph.
2. **Implementation.** Makes those tests pass. It does not edit them; a needed
   change goes back to the manager and into the brief first. Done means the
   row's outcome tests, the unit gate and the repository guards pass.
3. **Surface.** The web consumes the operation through the typed client and
   shows each state the operation's contract can answer as a story fed by
   answers recorded from the row's outcome tests: loading and populated always;
   empty, error and pending where the contract admits them (pending is a `202`
   and nothing else, so a read that answers only `200` or a problem has no
   pending story). A state is never made by editing a recorded answer; a
   missing one is first proved by the outcome test. Its gate is types, unit
   tests and stories. One browser journey per vertical runs in the program's
   nightly regression, not one per row.

A row is proved when its outcome tests pass on the shared stack. The surface
follows a proved row and never leads it.

## What blocks a landing

The tool decides, not the reviewer and not a mail:

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
  before any code (the tool still asks for the line `Read by program:`): which readers and writers it touches, and how each still
  passes;
- states the observable outcome ("reads per request do not depend on the number
  of matches"), never the mechanism to build. On 2026-10-12 "nothing replays
  the whole read" produced hand-written fences with three holes; "a bounded
  number of reads" was met by moving one loop;
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

## What this replaces

Reviews that run until nothing is found; three parallel review passes; a browser
proof for every row; classing a finding as must-do because it is a defect;
a manager's mail deciding each third review; briefs that name a mechanism to
build.
