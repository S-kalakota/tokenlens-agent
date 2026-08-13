# TokenLens Claude Code workflow

TokenLens is a project-scoped MCP tool that estimates the token cost of long or
context-heavy prompts and proposes lower-cost rewrites without changing the
user's intent.

## Tool usage

- The capability-gated native composer bridge is the target authority for
  pre-send optimization. Never call `optimize_prompt` automatically on a prompt
  that Claude has already received; that would duplicate analysis after the
  token spend has occurred.
- Stock Claude Code 2.1.231 does not provide the required native composer API.
  The plugin scaffold therefore remains inactive, and `tokenlens-claude` is only
  a legacy development harness rather than the completed native experience.
- Use `optimize_prompt` only when the user explicitly requests diagnostics or a
  fresh analysis of text already in the conversation.
- Present the highest-value rewrites with their estimated savings. Preserve the
  user's requirements and never silently remove constraints to save tokens.
- Reuse one `session_id` throughout a Claude Code conversation for explicit MCP
  analyses so TokenLens can resume related graph state.
- Use MCP `record_outcome` only for explicit analyses that bypassed a pre-send
  integration. A compatible native bridge records its own Accept, Skip, Edit,
  release, and usage events.
- If TokenLens is unavailable, continue with the user's request and report the
  integration failure concisely instead of blocking unrelated work.

## Development

- Keep MongoDB access inside `db/` and LightGBM loading inside
  `model/predictor.py`.
- Keep secrets in `.env`; never add credentials to `.mcp.json`, `CLAUDE.md`,
  source files, tests, or commits.
- Run `TOKENLENS_STUB=1 python3 -m unittest discover -s tests` after changes.
