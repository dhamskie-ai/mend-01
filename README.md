# mend

One patch tool for every AI edit format: `mend` applies an edit that an AI model wrote to a tree of text files — as a unified diff (even with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON. Every file is changed or nothing is.

`SPEC.md` is the whole specification.

## Running

Node 22, standard library only — no dependencies to install:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file (relative to the working directory, which is the root of the tree); when it is absent or `-`, the patch is read from standard input. `--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` reports what would change without writing anything; `--strict` matches lines exactly.

To run the practice set (from the kit):

```sh
node check.ts ../program/generator/practice.json
```

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner (kept as supplied by the kit).
- `check.ts` — the practice-set runner.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Competition

Built for the make.fun competition `hidden-spec-cli-01-run-20261122` — see https://make.fun for the competition details.
