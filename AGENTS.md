# AI agent instructions

REZICS is being rewritten. This repository contains only rebuilt parts.

## Precedence

1. The maintainer's current instruction.
2. This file.
3. Documents in this repository.
4. For topics not yet converted, the accepted ADRs and specifications in
   [rezics-next-discussion](https://github.com/rezics/rezics-next-discussion).

## Language

Everything in this repository is in English: code, comments, documents and commit messages. When you move a topic in
from rezics-next-discussion (Traditional Chinese), rewrite it in English; do not machine-translate it. Do not record who
said or decided what. Drop superseded material instead of carrying it over.

## One authority per topic

When a topic moves into this repository, replace its page in rezics-next-discussion with a pointer in the same change.
A topic is never authoritative in both places.

## Legacy code

The `legacy` branch (tags `legacy-final` and `legacy-main-final`) is a read-only reference.

- Do not merge it or copy it wholesale.
- Use it as a behaviour reference, and for differential tests where the meaning is unchanged.
- Port a piece only when the new contracts need it. Add tests for it, and name the source in the commit message as
  `legacy-final:<path>`.

## Working rules

- Put temporary files in `.temp/`.
- Keep task and ticket IDs out of code and documents; put them in commit messages.

Read the [development workflow](docs/development/README.md) and its linked Goal definitions.

Load [rezics-workflow](.agents/skills/rezics-workflow/SKILL.md) for all repository development work.
