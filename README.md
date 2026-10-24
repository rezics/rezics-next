# REZICS

REZICS is being rebuilt from scratch. This branch holds only what the rewrite has rebuilt; it starts empty on purpose.

## Where things are

- **Design.** Until a topic is converted into this repository, the source of truth is
  [rezics-next-discussion](https://github.com/rezics/rezics-next-discussion). Start with its README, then
  [ADR-0022](https://github.com/rezics/rezics-next-discussion/blob/main/docs/adr/0022-partitioned-authority-from-day-one.md)
  (partitioned authority),
  [ADR-0023](https://github.com/rezics/rezics-next-discussion/blob/main/docs/adr/0023-content-and-semantic-layers.md)
  (content and semantic layers), and engineering documents 18 and 19. That repository is written in Traditional
  Chinese; everything moved here is rewritten in English.
- **Previous implementation.** The `legacy` branch is frozen and kept for reference only. Two tags pin it:
  - `legacy-final`: all consolidated work at the start of the rewrite.
  - `legacy-main-final`: the last `main` that passed the merge gate.

## Reading legacy code

```sh
git worktree add ../rezics-legacy legacy-final   # browse or run the old tree
git show legacy-final:path/to/file               # read one file
```

## License

[GNU Affero General Public License v3.0](LICENSE).
