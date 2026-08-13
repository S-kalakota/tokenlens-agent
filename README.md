# TokenLens Agent

TokenLens Agent is a persistent pre-send prompt optimizer for Claude Code. It
estimates a draft's token cost, retrieves useful outcomes from prior sessions,
and proposes and rescores up to three rewrites. The target product flow runs in
the native `claude` composer: first Enter analyzes, Accept or Skip freezes a
choice, and second Enter releases that prompt exactly once.

It is a companion service: it does not import or require the TokenLens product at
runtime. A versioned LightGBM artifact and exported TokenLens history can be
supplied later; committed fixtures provide a complete offline demo meanwhile.

## Native Claude Code status

The reusable optimization, MongoDB, OpenRouter, model, MCP, and feedback layers
are implemented. `claude-code/` now contains the capability-gated native bridge,
structured UI contract, plugin scaffold, and fake-host safety suite.

Stock Claude Code 2.1.231 does not expose the composer API required to attach the
bridge. Its public `UserPromptSubmit` hook erases blocked prompts and cannot
preserve or replace the composer, render selectable controls, observe edits or
an empty second Enter, or release a stored rewrite. The plugin therefore fails
its compatibility gate instead of pretending a hook implements the requested
flow.

Check the installed host:

```sh
python3 claude-code/compatibility.py --json
claude plugin validate ./claude-code
```

The first command currently exits 1 by design and lists the missing native host
capabilities. The existing `tokenlens-claude` command remains a legacy
development harness for exercising the two-Enter state and backend; it is not
the requested native Claude Code UI.

### Temporary Claude Code display-only mode

For now, Claude Code can run the real analysis and display suggested prompts
without changing the composer. Add this to `.env`:

```sh
TOKENLENS_NATIVE_HOOK_APPROXIMATION=1
```

Then launch from this repository (not `tokenlens-claude`):

```sh
claude --plugin-dir ./claude-code \
  --settings '{"enabledPlugins":{"tokenlens@tokenlens":false}}'
```

First Enter analyzes and displays suggestions. Since public Claude Code erases
the blocked input, press Up + Enter to submit the original prompt unchanged.
To use a suggestion, copy or edit it into the composer, press Enter to analyze
that new wording, then Up + Enter sends it. This is a temporary compatibility
mode, not the eventual native selection-and-replace workflow.

## Legacy harness (offline fixture mode)

Python 3.11 or newer is required. From this directory:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -e '.[dev]'
cp .env.example .env
TOKENLENS_STUB=1 tokenlens-claude
```

The interaction is deliberately two-stage:

1. Enter freezes and analyzes the current draft. It cannot launch Claude.
2. Choose `1`, `2`, `3`, or `S`. This makes the selected prompt ready.
3. Press Enter again to send exactly that frozen prompt to Claude.

Any edit after analysis invalidates the result and requires a new first Enter.
`Ctrl-J` inserts a newline in the terminal composer; Enter performs the
state-dependent action.

Run the optimization graph without Claude:

```sh
TOKENLENS_STUB=1 python3 -m scripts.run_local \
  "Review these repeated logs and return only the root cause and patch."
```

Run all tests:

```sh
TOKENLENS_STUB=1 python3 -m unittest discover -s tests -v
```

## Production configuration

Copy `.env.example` to the ignored `.env` file and configure:

- `MONGODB_URI` for Atlas memory and LangGraph checkpoints.
- `OPENROUTER_API_KEY`, `TOKENLENS_REASON_CHEAP_MODEL`, and
  `TOKENLENS_REASON_STRONG_MODEL` for rewrite generation. Similar accepted
  savings and the current cost shape select between them at
  `TOKENLENS_REASON_STRONG_UPSIDE_TOKENS` (default 400 tokens). Setting the
  legacy `TOKENLENS_REASON_MODEL` forces one model and disables this routing.
- `model/booster.txt` with the versioned LightGBM artifact trained against the
  exact feature order in `model/featurizer.py`.
- `CLAUDE_BIN` if the Claude Code executable is not named `claude`.
- `TOKENLENS_STUB=0` to activate real adapters.

The legacy harness applies a child-process-only Claude settings override that
disables the separately installed `tokenlens@tokenlens` `UserPromptSubmit` gate.
This prevents an already approved harness prompt from being gated twice while
keeping the user's auth, model setting, project instructions, sessions, and
other plugins.

If a booster is temporarily unavailable, setting
`TOKENLENS_MODEL_FALLBACK=heuristic` explicitly enables a deterministic
development estimate. This is not a silent production fallback.

Create collections and indexes, then backfill exported JSON or JSONL history:

```sh
TOKENLENS_STUB=0 python3 -m db.backfill exported-sessions.jsonl \
  --ensure-indexes
```

The Atlas Automated Embedding/vector index may take time to become queryable.
Application collections are `draft_analyses`, `sessions`, `prompt_embeddings`,
`suggestions`, `user_profile`, `block_library`, and `checkpoints`.
`MongoDBSaver` also owns its internal `checkpoint_writes` collection.
Both checkpoint collections expire after 24 hours. Real mode fails closed if
LangGraph or the MongoDB checkpointer is unavailable; fixture mode alone may use
the dependency-free in-process graph. Outcome feedback also requires a
transaction-capable MongoDB deployment so suggestion, profile, and recurring-
block memory cannot be partially committed.

Raw draft retention is off by default. Set `TOKENLENS_RETAIN_RAW_PROMPTS=1` only
when retaining draft text is acceptable; exact hashes and derived features are
still kept for stale-result protection.

## Optional MCP diagnostics

`.mcp.json` registers a project-scoped stdio server. It exposes
`optimize_prompt` and `record_outcome` for explicit diagnostics of text already
in a conversation. MCP is not a pre-send interceptor and cannot substitute for
the native composer bridge.

Verify the server with:

```sh
claude mcp list
claude mcp get tokenlens
```

## Architecture

The graph is `gate -> retrieve -> reason -> rescore -> package`, with conditional
`skip` and deterministic recurring-block routes. MongoDB memory changes routing,
allowed rewrite types, calibration, and expected-value ranking; it is not merely
pasted into an LLM prompt. `MongoDBSaver` checkpoints graph state by optimization
session, while the native state contract intentionally never restores `ready`
send permission after a restart.

The canonical design and acceptance criteria are in
`tokenlens-agent-architecture.md` and `tokenlens-build-plan.md`.
