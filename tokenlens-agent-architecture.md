# TokenLens optimizer agent — architecture reference

## What this agent does

Given a prompt typed in the `tokenlens-claude` pre-send wrapper or pulled from a past session, the agent returns concrete rewrite suggestions that reduce token usage, each with a predicted savings number. It gets better over time because every accepted, skipped, edited, or completed analysis is logged, and future retrieval pulls from that history — this is the "no cold start" piece the hackathon theme asks for.

**Deployment boundary:** this agent runs alongside the existing TokenLens product as an independent Python/MCP service. It does not import, modify, or need the TokenLens application at runtime. The trained LightGBM booster and historical TokenLens sessions are optional integration inputs: when available they replace the placeholder booster and seed MongoDB; until then the agent can be developed and demonstrated with its committed fixtures.

## Required user workflow

TokenLens Agent is a **pre-send gate**. The stock Claude Code prompt composer
cannot provide this guarantee because pressing Enter there has already sent the
prompt to Claude. Users start the companion wrapper instead:

```sh
tokenlens-claude
```

The wrapper owns the editable prompt buffer and follows this contract:

1. The user writes a draft and presses **Enter** for the first time.
2. The wrapper freezes an exact snapshot, assigns an `analysis_id`, and hashes
   the UTF-8 prompt bytes with SHA-256.
3. TokenLens displays the original estimated cost as soon as the gate model
   returns. MongoDB retrieval and suggestion generation continue afterward.
4. The wrapper displays up to three rewrites with their estimated cost and
   savings. The user chooses **Accept 1/2/3** or **Skip**.
5. Accept selects the corresponding rewrite. Skip selects the original prompt.
   Either choice moves the draft to `ready` but does not contact Claude.
6. The user presses **Enter** a second time. The wrapper verifies that the
   current prompt hash, analyzed hash, and selected hash still agree, then sends
   only the selected prompt to Claude.
7. Any edit before the second Enter increments `draft_version`, invalidates the
   analysis and choice, cancels or ignores in-flight work, and returns to step 1.

Suggested terminal controls are `[1]`, `[2]`, or `[3]` to accept a rewrite,
`[S]` to skip optimization, `[E]` or normal typing to edit, and Enter to perform
the state-dependent action. These controls can later become graphical buttons
without changing the state contract.

### Pre-send state machine

| State | User/system event | Next state | Required behavior |
|---|---|---|---|
| `draft` | First Enter | `analyzing` | Snapshot and hash the prompt; never invoke Claude. |
| `analyzing` | Cost ready | `analyzing` | Display cost immediately while retrieval/reasoning continues. |
| `analyzing` | Suggestions ready | `review` | Display ranked rewrites and Accept/Skip controls. |
| `review` | Accept suggestion | `ready` | Select that rewrite and freeze its hash. |
| `review` | Skip | `ready` | Select the original prompt and freeze its hash. |
| `review` or `ready` | Any edit | `draft` | Increment version and clear analysis, selection, and stale UI. |
| `ready` | Second Enter | `sending` | Recheck hashes, record the decision, then invoke Claude once. |
| `sending` | Claude finishes | `draft` | Preserve the Claude session ID and open the next draft. |
| `sending` | Launch/stream failure | `ready` | Record `send_failed`; require explicit Enter to retry. |
| Any non-sending state | Analysis failure | `draft` | Show the error; keep the prompt editable and unsent. |

There is no transition from `draft`, `analyzing`, or `review` directly to
`sending`. That invariant is what prevents accidental token spend.

## Where each piece lives

```
User
  |
  v  first Enter
Pre-send wrapper (`tokenlens-claude`)
  |-- cost-ready event --> display original cost immediately
  |-- review UI        --> Accept / Skip / Edit
  |
  v  direct Python call: analyze_draft(prompt snapshot)
Optimization service
      |
      v
LangGraph orchestrator (agent/graph.py)
   |-- gate node        --> LightGBM quantile model
   |-- retrieve node     --> MongoDB Atlas Vector Search
   |-- reason node       --> OpenRouter (Claude / other model)
   |-- rescore node      --> LightGBM quantile model
   |-- package node       --> returns ranked suggestions to wrapper
      |
      v
MongoDB Atlas (draft analyses, sessions, suggestions, profiles, blocks,
               embeddings, checkpoints)
      |
      ^ decision and outcome write-back

Pre-send wrapper
  |
  v  second Enter, only from `ready`
Claude Code print mode (`claude -p`, resumed by session ID)
```

---

## 1. Pre-send wrapper and Claude handoff

The wrapper is a small terminal UI, not a patch to Claude Code. It invokes the
optimization graph in-process so it can receive a fast `cost_ready` event before
the slower MongoDB and OpenRouter stages finish. MCP is not used for interception.

For the proof of concept, the wrapper invokes Claude Code in print mode without
a shell and consumes structured streaming output:

```text
new conversation: claude -p <approved_prompt> --output-format stream-json --verbose
later turn:       claude -p --resume <claude_session_id> <approved_prompt>
                  --output-format stream-json --verbose
```

The wrapper captures the Claude result's session ID and resumes that same session
for later approved prompts. The working directory must stay fixed so Claude can
find its persisted session. A later implementation may use `ClaudeSDKClient`,
but it must preserve the same pre-send states and must never send an analyzing or
unapproved draft.

The cost source is an interface. In production, the preferred adapter loads the
versioned TokenLens LightGBM booster; during development, fixtures satisfy the
same contract. TokenLens itself does not need to be running. The original cost,
prompt snapshot, and MongoDB context are passed together to the graph, and the
same frozen prediction context is used to rescore every rewrite.

### Draft identity and stale-result protection

Each analysis stores `{analysis_id, draft_version, original_prompt,
original_prompt_hash}`. Every asynchronous event includes the same identifiers.
The wrapper discards events whose version or hash no longer matches the live
draft. A `ready` selection stores `{selected_prompt, selected_prompt_hash,
decision}`. The second Enter recomputes the hash from the visible buffer; a
mismatch returns to `draft` instead of sending.

## 2. Optional Claude Code MCP client

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

Claude Code discovers the `optimize_prompt` tool from the MCP server. When the
user entered through `tokenlens-claude`, `CLAUDE.md` must not instruct Claude to
optimize the same prompt again. The wrapper is authoritative for pre-send gating;
MCP remains available when a user explicitly asks for another analysis.

---

## 3. Optimization service and MCP adapter (`mcp_server.py`)

The optimization service exposes an in-process asynchronous API to the wrapper.
It emits cost before suggestions so the first-Enter UI feels immediate:

```python
async def analyze_draft(request: AnalyzeDraftRequest) -> AsyncIterator[
    CostReady | SuggestionsReady | AnalysisFailed
]: ...
```

`AnalyzeDraftRequest` includes `analysis_id`, `draft_version`, `prompt`,
`prompt_hash`, `user_id`, `project`, and `optimization_session_id`. The wrapper
must validate identifiers on every event.

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
pre-send wrapper owns draft state and permission to launch Claude.

---

## 4. LangGraph orchestrator (`agent/graph.py`)

This is the core. A graph of nodes with shared state, compiled with a MongoDB checkpointer so a crash mid-run doesn't lose progress — this directly matches the "state & persistence" pattern MongoDB provided as a reference resource.

**Nodes:**

- **gate** — runs the prompt through the LightGBM model first. If predicted cost is already low relative to the user's typical prompts, short-circuits and returns early. This is the cost-conscious pre-filter.
- **retrieve** — queries MongoDB Atlas Vector Search for the k most similar past prompts, and pulls whichever of their logged suggestions were actually accepted and reduced tokens. This is the memory step — it's what makes suggestions specific to this user's patterns instead of generic advice.
- **reason** — calls the LLM (via OpenRouter) with the current prompt plus the retrieved examples as grounding context, and asks it to propose specific rewrites (e.g. "collapse repeated file dump," "trim boilerplate instructions," "deduplicate context").
- **rescore** — runs each proposed rewrite back through the LightGBM model to get a real predicted cost, and computes the delta against the original. This replaces "trust the LLM's claim" with an actual quantitative estimate.
- **package** — formats the final suggestions object and returns it through the optimization service to the wrapper or optional MCP adapter.

**State object** carried through the graph: `{ prompt, session_id, predicted_cost, retrieved_examples, candidate_rewrites, scored_rewrites }`.

**Checkpointing:** `langgraph-checkpoint-mongodb`'s `MongoDBSaver` is passed at graph compile time. Every node's state write is automatically persisted to the `checkpoints` collection — no manual read/write code needed.

---

## 5. LightGBM quantile model

The preferred production model is TokenLens's existing trained booster, supplied to this companion service as a versioned artifact rather than imported from the TokenLens runtime. Until that artifact is supplied, the committed placeholder keeps the boundary explicit. There are two call sites:

- **gate node** — scores the raw prompt as-is.
- **rescore node** — scores each candidate rewrite.

Both call sites use the same featurizer (whatever features the model was trained on: prompt length, structure signals, repeated-block counts, etc.) so the numbers are directly comparable — the delta between gate output and rescore output *is* the "estimated savings" shown to the user.

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

The wrapper records decisions because it directly observes Accept, Skip, Edit,
and second Enter. Claude does not need to infer them. Accept marks the chosen
suggestion; Skip records that the original was deliberately sent; an edit marks
the old analysis as abandoned without treating it as a rejected suggestion.
Only a successful second-Enter handoff marks the selected prompt as sent.

After Claude returns usage data, the wrapper records actual cost and savings when
available. `record_outcome` updates the corresponding suggestion, user profile,
and recurring-block statistics in one write path. The next retrieval therefore
uses real decisions and outcomes rather than guesses. MCP feedback is a fallback
only for prompts that did not enter through the wrapper.

---

## End-to-end trace of one call

1. User starts `tokenlens-claude`, writes a prompt, and presses Enter.
2. Wrapper creates version 7 and hash `H1`; Claude has not been invoked.
3. **gate** emits a p50 cost of 1,240 tokens, which appears immediately.
4. **retrieve** finds three similar prompts and two accepted rewrites in Atlas.
5. **reason** proposes two rewrites grounded in that user history.
6. **rescore** estimates 720 and 1,150 tokens, or savings of 520 and 90.
7. Wrapper enters `review` and shows Accept 1, Accept 2, Skip, and Edit.
8. User accepts rewrite 1. Wrapper stores its hash `H2` and enters `ready`.
9. If the user edits, the wrapper invalidates `H1`/`H2` and restarts at step 1.
10. Otherwise the user presses Enter again. The wrapper rechecks the visible
    buffer against `H2`, records the decision, and invokes `claude -p` once.
11. Claude's streamed response is displayed and its session ID is retained for
    the next approved turn.
12. MongoDB records the sent prompt, choice, predicted savings, and actual usage
    when available. Checkpoints preserve unfinished optimization work, never an
    unapproved permission to send.
