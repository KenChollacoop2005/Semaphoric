# Project Semaphoric — Claude Code notes

Read SPEC.md first. It is the source of truth for scope and build order.

## Working style
- Build in the phase order in SPEC.md. Filter first; do not start P2P until Phase 1 is solid.
- Be surgical. No blanket find-and-replace.
- Stop and flag before any nontrivial rewrite or architecture change.
- Root cause before fixes. Revert rather than stack speculative changes.
- When a choice is left open in the spec (e.g. delta encoding format), measure the options and report numbers before committing.

## Code conventions
- Vanilla JS ES modules, no framework, no build step.
- Named constants for every tunable value (margins, thresholds, fps cap, keyframe interval).
- Comments are short labels only (about 8 words or fewer, one line). No docstrings or multi-line explanations.

## Honesty
- The bandwidth claim is a hypothesis. Report measured numbers as they are.
- Keep the naive filter mode working at all times for comparison.

## Running locally
- ES modules and `getUserMedia` need http on localhost, not `file://`.
- `python -m http.server 8000` from the repo root, then open http://localhost:8000.
