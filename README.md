# TokenLens agent

This directory implements Parts 1 and 2 of `tokenlens-build-plan.md`: the
context-model data shapes, Phase 0 repository skeleton, stable cross-layer
contracts, feature buckets, and committed stubs.

TokenLens Agent is a standalone companion service. It runs beside the existing
TokenLens product rather than importing or modifying that application. A trained
TokenLens LightGBM booster and exported session history can be supplied later as
integration inputs; the companion's process, MCP interface, storage, and release
lifecycle remain independent.

## Claude Code integration

TokenLens is configured as a project-scoped Claude Code MCP server in
`.mcp.json`. Run Claude Code from this repository root so
`CLAUDE_PROJECT_DIR` resolves to this checkout:

```sh
claude mcp list
claude mcp get tokenlens
claude
```

On first use, approve the project-scoped `tokenlens` server. Inside Claude Code,
use `/mcp` to inspect its connection state. `CLAUDE.md` tells Claude when to call
`optimize_prompt` and when to record feedback with `record_outcome`.

The committed MCP configuration contains no credentials. Keep
`MONGODB_URI` and `OPENROUTER_API_KEY` in the ignored `.env` file and export
them into the environment before starting Claude Code when running outside
stub mode.

## Phase 0 behavior

Set `TOKENLENS_STUB=1` to make these boundaries return committed fixtures:

- `model.predictor.predict` and `predict_many`
- `db.repo.load_context`
- `db.repo.find_similar`
- `agent.nodes.reason.call_reasoning_model`

Block fingerprinting and sparse acceptance-rate shrinkage are dependency-free
pure helpers. MongoDB writes, real LightGBM inference, graph orchestration, and
the FastMCP adapter remain explicit `NotImplementedError` boundaries because
they start in Part 3. Consequently, Claude Code can discover the project MCP
configuration now, but the server will not stay connected until the FastMCP
adapter is implemented and its dependency is installed.

## Verify

From this directory:

```sh
TOKENLENS_STUB=1 python3 -m unittest discover -s tests
```

The placeholder `model/booster.txt` must be replaced with the existing trained
LightGBM export before real model work begins.
