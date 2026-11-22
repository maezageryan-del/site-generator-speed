# Fast makefun-site drop-in — exact answers, compiled templates

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/maezageryan-del/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/maezageryan-del/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, written for the
[site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` answers every case exactly as the reference does — front-matter refusals in
their exact order, slug collisions, non-ASCII slugs, the Markdown subset, the template
dialect with its exact error strings, link resolution and the build report — while
running about **2.8x faster than the reference on the practice set** (CPU time, ~270 ms
vs ~750 ms per set on the build box).

## How it works

- **Compiled templates:** each template is compiled once per case to a plain JavaScript
  function whose control flow is the template's own, so a render pays no per-node
  dispatch, no per-iteration closure and no fresh scope object per loop turn. Includes
  resolve through the same compiled map, with the 8-deep limit kept.
- **Bulk inline rendering:** the Markdown inline renderer jumps straight to the next
  markup character with one scan and escapes plain runs in bulk, instead of escaping
  one character at a time.
- **Memoised slugs:** titles, tag names and heading texts repeat heavily (respellings,
  collisions), so each slug is computed once per case; pure-ASCII input skips the
  NFKD normalisation pass.
- **Fused Markdown pass:** lexing and rendering run in one pass with no token objects,
  and lines are classified once by their first character.
- **No per-word allocations:** reading time counts word runs with a plain scan instead
  of building a match array, and front matter is parsed without splitting and
  re-joining the whole body.

## Correctness

Verified against the reference implementation before submitting:

- Practice set: **3/3 exact** (kit `grade-local`, process driver).
- Fresh generator-drawn sets: **126 cases, 0 mismatches** (differential check against
  makefun-site 1.0.0 on new seeds from the kit's own generator).
- Hand-written edge battery: **174 cases, 0 mismatches** — every front-matter refusal
  reason, leap-year and date bounds, quoted-string escapes, fence/heading/list/
  blockquote quirks, link targets (drafts, refusals, missing files, climbing above
  the root, statics, fragments), template parse errors, include cycles, prototype
  paths (`page.constructor`), slug collisions and static shadowing.
- Deterministic: two full runs of the practice set are byte-identical.
- Local grader simulation: repo read-only, foreign working directory,
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set — exit 0, answers 3/3 exact.

The house driver `main.ts` is kept verbatim (it turns V8's incremental marking off
before importing `solve.js`).
