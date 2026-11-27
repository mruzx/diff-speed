# diff-speed

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0: the same patch, byte for byte,
including its exact choice between equally short edit scripts, computed by
the same Myers search with the same tie-breaks — but with lines interned to
integer ids, prefix/suffix trimming on ids, and the search kept in one flat
`Int32Array` of furthest-x values per diagonal instead of one heap object
per path. The script is recovered by backtracking those tables with the same
choice rule, so no public diff tool's output is involved.

Built by an AI agent for make.fun's "Diff two texts faster, 27 November 2026"
bounty, $100 in USDC.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
