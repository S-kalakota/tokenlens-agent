# TokenLens optimizer agent — architecture reference

## What this agent does

Given a prompt typed in the native Claude Code composer or pulled from a past
session, the agent returns concrete rewrite suggestions that reduce token usage,
each with a predicted savings number. It gets better over time because every
accepted, skipped, edited, or completed analysis is logged, and future retrieval
pulls from that history — this is the "no cold start" piece the hackathon theme
asks for.

**Deployment boundary:** this agent runs as an independent Python/MCP service.
It vendors the checksum-pinned `model_combined.joblib` output-token estimator
trained in `nkanthed06/Token_Counter`, while historical TokenLens sessions may
seed MongoDB. Fixture mode remains available without external services.

## Required user workflow

TokenLens Agent is a **native Claude Code pre-send gate**. Users start the normal
interactive Claude Code application:

```sh
claude
```

Claude Code remains visible for the entire conversation. A TokenLens native
composer integration intercepts submission before the prompt enters Claude's
model context and follows this contract:

1. The user writes a draft and presses **Enter** for the first time.
2. The integration freezes an exact snapshot, assigns an `analysis_id`, and hashes
   the UTF-8 prompt bytes with SHA-256.
3. TokenLens displays the original estimated cost as soon as the gate model
   returns. MongoDB retrieval and suggestion generation continue afterward.
4. TokenLens displays up to three rewrites with their estimated cost and savings
   inside the native Claude Code UI. The user chooses **Accept 1/2/3** or **Skip**.
5. Accept selects the corresponding rewrite. Skip selects the original prompt.
   Either choice moves the draft to `ready` but does not contact Claude.
6. The selected text remains in Claude Code's native composer. The user presses
   **Enter** a second time. The integration verifies that the current composer
   hash, analyzed hash, and selected hash still agree, then releases only the
   selected prompt to Claude exactly once.
7. Any edit before the second Enter increments `draft_version`, invalidates the
   analysis and choice, cancels or ignores in-flight work, and returns to step 1.

Controls are `[1]`, `[2]`, or `[3]` to accept a rewrite, `[S]` to skip
optimization, `[E]` or normal typing to edit, and Enter to perform the
state-dependent action. They must be rendered within Claude Code rather than in
a separate TokenLens terminal application.

### Required Claude Code host capabilities

The native integration must have supported APIs that can:

1. intercept a submitted prompt before any model request;
2. prevent that request while preserving or restoring the exact composer text;
3. render asynchronous cost and suggestion results in the interactive UI;
4. replace the composer text with an accepted rewrite;
5. observe edits and the next Enter; and
6. release the selected prompt into the same Claude Code session exactly once.

A plain `UserPromptSubmit` hook is not sufficient today. Claude Code's current
hook contract can block processing, but a blocked submission is erased from the
composer/context; it does not expose APIs to replace the composer buffer, add
interactive suggestion controls, or reinterpret an empty second Enter. MCP is
also too late because tool selection occurs only after a prompt is submitted.
Therefore the production implementation requires an official native composer
extension API or a maintained Claude Code build/host adapter that supplies the
six capabilities above. If none is available, installation must fail its
compatibility check rather than silently fall back to post-send optimization.
This constraint follows the current official
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit),
which states that blocking `UserPromptSubmit` prevents processing and erases the
prompt. Revalidate the host API against that reference before each supported
Claude Code release.

### Migration status

The repository's existing `tokenlens-claude` terminal wrapper implements the old
companion workflow and does **not** satisfy this native-UI architecture. The
LangGraph, MongoDB, model, optimization-service, and MCP layers remain reusable.
The wrapper-specific composer, renderer, `claude -p` client, and child-process
session handoff must be replaced by the native bridge described here. Until the
Phase 0 host-capability gate passes, the desired native workflow is specified but
not implemented.

### Temporary display-only compatibility mode

Until that host API exists, the repository may enable an explicitly opt-in
`UserPromptSubmit` compatibility mode. It analyzes the first submission with
the real TokenLens backend, blocks it, and displays copyable suggestions. It
does **not** modify the composer or provide native controls: Claude Code erases
the blocked input, so the user presses Up + Enter to send the original unchanged
or pastes/edits a suggestion, analyzes that changed text, and then presses Up +
Enter to send it. This is useful for validating MongoDB, OpenRouter, retrieval,
and scoring in the normal `claude` UI, but it is not a substitute for the target
native workflow and has the public hook's fail-open timeout behavior.

### Pre-send state machine

| State | User/system event | Next state | Required behavior |
|---|---|---|---|
| `draft` | First Enter | `analyzing` | Intercept, snapshot, and hash the native composer; do not release it to Claude. |
| `analyzing` | Cost ready | `analyzing` | Display cost in Claude Code while retrieval/reasoning continues. |
| `analyzing` | Suggestions ready | `review` | Display ranked rewrites and Accept/Skip controls in Claude Code. |
| `review` | Accept suggestion | `ready` | Replace the native composer with that rewrite and freeze its hash. |
| `review` | Skip | `ready` | Restore the original text to the native composer and freeze its hash. |
| `review` or `ready` | Any edit | `draft` | Increment version and clear analysis, selection, and stale UI. |
| `ready` | Second Enter | `sending` | Recheck the live composer hash, record the decision, and release once. |
| `sending` | Claude accepts turn | `draft` | Stay in the same native session and open the next composer. |
| `sending` | Submission failure | `ready` | Record `send_failed`; restore the selected text and require explicit Enter to retry. |
| Any non-sending state | Analysis failure | `draft` | Show the error and preserve the native composer text unsent. |

There is no transition from `draft`, `analyzing`, or `review` directly to
`sending`. That invariant is what prevents accidental token spend.

## Where each piece lives

```
User
  |
  v  first Enter
Native Claude Code composer + TokenLens integration
  |-- cost-ready event --> display original cost immediately
  |-- review UI        --> Accept / Skip / Edit
  |
  v  direct Python call: analyze_draft(prompt snapshot)
Optimization service
      |
      v
LangGraph orchestrator (agent/graph.py)
   |-- gate node        --> trained output-token model
   |-- retrieve node     --> MongoDB Atlas Vector Search
   |-- reason node       --> OpenRouter (Claude / other model)
   |-- rescore node      --> trained output-token model
   |-- package node       --> returns ranked suggestions to native integration
      |
      v
MongoDB Atlas (draft analyses, sessions, suggestions, profiles, blocks,
               embeddings, checkpoints)
      |
      ^ decision and outcome write-back

Native composer integration
  |
  v  second Enter, only from `ready`: release selected prompt
Claude Code's current interactive session and model request
```

---

## 1. Native Claude Code composer integration

The integration is installed as a Claude Code plugin/host extension and runs
inside the normal interactive `claude` experience. It invokes the optimization
service before Claude receives the prompt, streams `cost_ready` and suggestion
events into native UI regions, and retains send permission until the user makes
an explicit choice and presses Enter again. It never launches a nested
`claude -p` process and never creates a parallel conversation or terminal UI.

The adapter between TokenLens and Claude Code is a narrow `NativeComposerPort`.
All Claude-version-specific behavior lives behind that port. Startup performs a
capability handshake for buffer preservation, UI rendering, replacement, edit
events, and guarded release. An unsupported Claude Code version disables the
integration with a clear setup error before the user types a prompt.

The cost source is an interface. In production, the preferred adapter loads the
versioned Token Counter scikit-learn artifact; during development, fixtures satisfy the
same contract. TokenLens itself does not need to be running. The original cost,
prompt snapshot, and MongoDB context are passed together to the graph, and the
same frozen prediction context is used to rescore every rewrite.

### Draft identity and stale-result protection

Each analysis stores `{analysis_id, draft_version, original_prompt,
original_prompt_hash}`. Every asynchronous event includes the same identifiers.
The native integration discards events whose version or hash no longer matches
the live composer. A `ready` selection stores `{selected_prompt,
selected_prompt_hash, decision}`. The second Enter recomputes the hash from the
visible composer; a mismatch returns to `draft` instead of releasing the prompt.

## 2. Claude Code plugin, hook, and optional MCP roles

The installable Claude Code plugin packages the native bridge, compatibility
metadata, and any lifecycle hooks. A `UserPromptSubmit` hook may be used as a
defense-in-depth assertion that an unapproved prompt is blocked, but it is not
the composer UI implementation and must not be presented as one.

Claude Code may also connect to TokenLens through MCP for explicit diagnostics,
re-analysis of text already in a conversation, or recording feedback. This is an
optional secondary surface. It cannot enforce the two-Enter pre-send workflow
because Claude receives the prompt before it can choose an MCP tool.

TokenLens is registered as a project-scoped stdio server in `.mcp.json` at the
repository root, so the shared configuration can be committed without secrets.
Claude Code asks the user to approve a project-scoped server the first time it is
encountered.

**What you configure:**
```json
{
  "mcpServers": {
    "tokenlens": {
      "type": "stdio",
      "command": "python3",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp_server.py"],
      "env": {
        "TOKENLENS_STUB": "${TOKENLENS_STUB:-1}"
      }
    }
  }
}
```

The equivalent setup command, run from the repository root, is:

```sh
claude mcp add --transport stdio --scope project tokenlens -- python3 '${CLAUDE_PROJECT_DIR:-.}/mcp_server.py'
```

Use `claude mcp list` or `claude mcp get tokenlens` before starting a session, and `/mcp` inside Claude Code, to verify that the server is connected and approved. The shared configuration defaults to `TOKENLENS_STUB=1` during the walking-skeleton phases; export `TOKENLENS_STUB=0` when the real implementations land. Secrets such as `MONGODB_URI` and `OPENROUTER_API_KEY` remain in the ignored `.env`; the Python process must load that file or receive the variables from its parent environment.

Claude Code discovers the `optimize_prompt` tool from the MCP server. `CLAUDE.md`
must not instruct Claude to optimize a prompt already handled by the native
pre-send integration. The native integration is authoritative for pre-send
gating; MCP remains available when a user explicitly asks for another analysis.

---

## 3. Optimization service and MCP adapter (`mcp_server.py`)

The optimization service exposes an asynchronous API to the native Claude Code
bridge. It emits cost before suggestions so the first-Enter UI feels immediate:

```python
async def analyze_draft(request: AnalyzeDraftRequest) -> AsyncIterator[
    CostReady | SuggestionsReady | AnalysisFailed
]: ...
```

`AnalyzeDraftRequest` includes `analysis_id`, `draft_version`, `prompt`,
`prompt_hash`, `user_id`, `project`, and `optimization_session_id`. The native
bridge must validate identifiers on every event.

The thin FastMCP adapter exposes the same graph for optional calls from Claude:

```
optimize_prompt(prompt: str, session_id: str | None) -> {
  analysis_id,
  prompt_hash,
  suggestions: [ { rewrite, estimated_savings, rationale } ],
  original_predicted_cost: { p10, p50, p90 }
}
```

Neither adapter owns optimization logic. Both invoke the same graph, but only the
native composer integration owns draft state and permission to release a prompt
to Claude.

---

## 4. LangGraph orchestrator (`agent/graph.py`)

This is the core. A graph of nodes with shared state, compiled with a MongoDB checkpointer so a crash mid-run doesn't lose progress — this directly matches the "state & persistence" pattern MongoDB provided as a reference resource.

**Nodes:**

- **gate** — runs the prompt through the trained output-token model first. If predicted cost is already low relative to the user's typical prompts, short-circuits and returns early. This is the cost-conscious pre-filter.
- **retrieve** — queries MongoDB Atlas Vector Search for the k most similar past prompts, and pulls whichever of their logged suggestions were actually accepted and reduced tokens. This is the memory step — it's what makes suggestions specific to this user's patterns instead of generic advice.
- **reason** — calls the LLM (via OpenRouter) with the current prompt plus the retrieved examples as grounding context, and asks it to propose specific rewrites (e.g. "collapse repeated file dump," "trim boilerplate instructions," "deduplicate context").
- **rescore** — runs each proposed rewrite back through the same trained model to get a predicted output length, and computes the delta against the original. This replaces "trust the LLM's claim" with an actual quantitative estimate.
- **package** — formats the final suggestions object and returns it through the optimization service to the native integration or optional MCP adapter.

**State object** carried through the graph: `{ prompt, session_id, predicted_cost, retrieved_examples, candidate_rewrites, scored_rewrites }`.

**Checkpointing:** `langgraph-checkpoint-mongodb`'s `MongoDBSaver` is passed at graph compile time. Every node's state write is automatically persisted to the `checkpoints` collection — no manual read/write code needed.

---

## 5. Trained output-token model

Production uses the vendored `model/model_combined.joblib` scikit-learn pipeline
from `nkanthed06/Token_Counter`. It was trained on 12,052 Haiku 4.5 and Sonnet 5
coding-prompt rows and predicts `log1p(output_tokens)`. The adapter in
`model/output_estimator.py` builds its fixed 14-feature row, inverts the target
with `expm1`, and applies the upstream empirical 80% ratio band. The artifact is
loaded once and verified against its SHA-256 manifest. There are two call sites:

- **gate node** — scores the raw prompt as-is.
- **rescore node** — scores each candidate rewrite.

Both call sites use the same classifier, repository metrics, explicit-file
references, and prompt-structure counts, and rescoring is one batch model call.
The delta between gate and rescore output estimates is the savings shown to the
user. The trained model supports `claude-haiku-4-5` and `claude-sonnet-5` only;
other targets visibly use the upstream fixed 1,200-output-token assumption. The
upstream pylint validation fixture (`assert-on-string-literal` plus `empty
literals`) retains its exact 590-token result and [324, 1062] interval.

**Why it matters for judging:** it's the concrete technical differentiator. An LLM proposing "make this shorter" is generic; a trained model quantifying the actual predicted cost reduction is a real system, not a prompt-engineering demo.

**Future extension (not required for the hackathon, worth mentioning in the demo):** every real outcome logged in `suggestions` (predicted vs. actual token count) is training data for periodically retraining or recalibrating the model — closing the loop from "predicts" to "learns from being wrong."

---

## 6. MongoDB Atlas

Seven collections, one cluster.

**`sessions`** — one document per prompt actually sent to Claude.
```
{ _id, session_id, prompt_text, predicted_cost, actual_cost, project, timestamp }
```

**`prompt_embeddings`** — vector index over `sessions.prompt_text`, populated via Atlas **Automated Embeddings** so there's no separate embedding pipeline to run or maintain. This is what `retrieve` queries against.

**`suggestions`** — one document per suggestion ever generated.
```
{ _id, session_id, suggestion_type, rewrite_text, predicted_savings,
  accepted: bool, actual_savings, timestamp }
```
This is the memory table. Its accumulated content is what makes retrieval useful over time.

**`user_profile`** — derived cost quantiles, per-project calibration, completion
ratios, and acceptance rates used by gate, reason, rescore, and package.

**`block_library`** — recurring fenced blocks and sliding-window hashes, their
occurrence counts, and whether the user has accepted collapsing them before.

**`checkpoints`** — managed automatically by `MongoDBSaver`. You don't write to this directly.

**`draft_analyses`** — one immutable record per first-Enter analysis. It stores
`analysis_id`, `draft_version`, prompt hashes, original cost, candidate IDs,
decision (`accepted`, `skipped`, `edited`, or `failed`), selected hash, timestamps,
and the Claude session ID only after a successful second-Enter handoff. Raw prompt
retention must be configurable; hashes and derived features are sufficient for
stale-result protection.

---

## 7. LLM layer

**OpenRouter** is the primary path — one API key, one client (`langchain-openai` pointed at OpenRouter's base URL), and you can swap the underlying model without touching integration code. Used in the `reason` node.

**Fireworks** is optional, worth adding only if you want a second, cheaper/faster model specifically for the `gate` node's lightweight pre-checks, so the expensive reasoning model is reserved for prompts that actually need it.

---

## 8. Feedback loop

The native integration records decisions because it directly observes Accept,
Skip, Edit, and second Enter. Claude does not need to infer them. Accept marks
the chosen suggestion; Skip records that the original was deliberately sent; an
edit marks the old analysis as abandoned without treating it as a rejected
suggestion. Only a successful second-Enter release into Claude's model request
marks the selected prompt as sent.

After Claude returns usage data, the native integration records actual cost and
savings when available. `record_outcome` updates the corresponding suggestion,
user profile, and recurring-block statistics in one write path. The next
retrieval therefore uses real decisions and outcomes rather than guesses. MCP
feedback is a fallback only for prompts that bypassed the native integration.

---

## End-to-end trace of one call

1. User starts the normal `claude` UI, writes a prompt, and presses Enter.
2. The native integration intercepts the submission, creates version 7 and hash
   `H1`, and preserves the prompt in the composer; Claude has not received it.
3. **gate** emits a p50 cost of 1,240 tokens, which appears immediately.
4. **retrieve** finds three similar prompts and two accepted rewrites in Atlas.
5. **reason** proposes two rewrites grounded in that user history.
6. **rescore** estimates 720 and 1,150 tokens, or savings of 520 and 90.
7. The integration enters `review` and shows Accept 1, Accept 2, Skip, and Edit
   inside Claude Code.
8. User accepts rewrite 1. The integration places it in the native composer,
   stores its hash `H2`, and enters `ready`.
9. If the user edits, the integration invalidates `H1`/`H2` and restarts at step 1.
10. Otherwise the user presses Enter again. The integration rechecks the native
    composer against `H2`, records the decision, and releases the prompt into the
    current interactive Claude session once.
11. Claude handles and displays the turn normally; no nested process or parallel
    session exists.
12. MongoDB records the sent prompt, choice, predicted savings, and actual usage
    when available. Checkpoints preserve unfinished optimization work, never an
    unapproved permission to send.
