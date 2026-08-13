# TokenLens Claude Code workflow

TokenLens is a project-scoped MCP tool that estimates the token cost of long or
context-heavy prompts and proposes lower-cost rewrites without changing the
user's intent.

## Tool usage

- Before acting on a long, repetitive, or context-heavy user request, call the
  TokenLens `optimize_prompt` MCP tool with the complete request.
- Present the highest-value rewrites with their estimated savings. Preserve the
  user's requirements and never silently remove constraints to save tokens.
- Reuse one `session_id` throughout a Claude Code conversation so TokenLens can
  resume graph state and learn from related turns.
- After the user accepts, edits, rejects, or ignores a suggested rewrite, call
  `record_outcome` exactly once with the real outcome. Do not invent acceptance
  or savings when the user's choice is ambiguous.
- If TokenLens is unavailable, continue with the user's request and report the
  integration failure concisely instead of blocking unrelated work.

## Development

- Keep MongoDB access inside `db/` and LightGBM loading inside
  `model/predictor.py`.
- Keep secrets in `.env`; never add credentials to `.mcp.json`, `CLAUDE.md`,
  source files, tests, or commits.
- Run `TOKENLENS_STUB=1 python3 -m unittest discover -s tests` after changes.
