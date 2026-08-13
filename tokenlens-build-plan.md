# TokenLens optimizer agent — build plan

Companion to `tokenlens-agent-architecture.md`. That doc says what the system is. This one says what gets built, by whom, in what order, and what has to be true before the next thing starts.

Four organizing ideas:

1. **Contracts before parallelism.** An hour of schema work up front lets four build agents run without stepping on each other. Skip it and the back half of the build is spent reconciling field names.
2. **Walking skeleton first.** Every layer ships a stub on day one so the full path (draft -> first Enter -> cost/suggestions -> Accept or Skip -> second Enter -> fake Claude response) runs end to end before any component is real. Then stubs get replaced one at a time.
3. **Companion, not coupling.** The agent is deployed beside TokenLens, not inside it. It owns its process, MongoDB collections, MCP surface, and configuration. TokenLens may later supply a booster artifact and exported session history, but neither codebase imports the other and the companion remains runnable with fixtures when those inputs are absent.
4. **No approval, no send.** Only the pre-send wrapper may invoke Claude, and only a `ready` draft created by an explicit Accept or Skip decision may cross that boundary. MCP is optional and cannot replace the wrapper because it runs after Claude has already received a prompt.

---

## 1. The pre-send interaction contract

Users launch `tokenlens-claude`, not the stock Claude composer, when they want
pre-send optimization. The wrapper owns the prompt buffer and interprets Enter
according to state:

```text
draft --first Enter--> analyzing --suggestions--> review
review --Accept/Skip--> ready --second Enter--> sending --> next draft
review/ready --edit--> draft
```

- First Enter snapshots the prompt, increments `draft_version`, creates an
  `analysis_id`, and computes a SHA-256 hash over the exact UTF-8 bytes.
- The cost result renders immediately. Retrieval, OpenRouter reasoning, and
  rewrite rescoring continue asynchronously.
- `[1]`, `[2]`, or `[3]` accepts a ranked rewrite; `[S]` skips and keeps the
  original. Accept or Skip is mandatory before second Enter.
- Accept replaces the visible buffer with the selected rewrite. Skip leaves the
  original visible. Both freeze a `selected_prompt_hash` and enter `ready`.
- Any edit in `review` or `ready` invalidates the analysis and selection. The
  next Enter is another first Enter, never a send.
- Second Enter recomputes the visible-buffer hash and requires equality with the
  analyzed/selected version before launching Claude.
- Stale async results are discarded by `{analysis_id, draft_version,
  prompt_hash}`. A canceled task is never allowed to repaint the current UI.
- A restart never restores `ready` permission. The user must analyze and choose
  again, even if graph checkpoints can resume internal optimization work.

The wrapper launches `claude -p` as an argv array, never through a shell, reads
`--output-format stream-json`, captures the returned Claude session ID, and uses
`--resume <session_id>` for subsequent approved turns from the same working
directory. If launch or streaming fails, record `send_failed`, return to `ready`,
and require another explicit Enter; never retry a possibly delivered prompt
automatically.

### UI acceptance criteria

The terminal must make the boundary visible:

```text
Original estimate: 1,240 tokens
Analyzing history…

[1] 720 tokens  Save 520 (42%)  Collapse repeated schema
[2] 1,150 tokens  Save 90 (7%)  Trim boilerplate
[S] Skip and keep original

Choice: 1
Ready to send optimized prompt. Press Enter to send; editing restarts analysis.
```

No Claude process may start before the final line and the second Enter.

---

## 2. The context model

This is the part the brief is actually testing. Storing state is easy. The requirement is that what you store and retrieve **changes what the system does next**, not that it gets pasted into a prompt. So the design rule for this project is:

> Every read from Mongo must be attached to a decision the system would otherwise make differently. If a retrieved value only ever lands in a prompt string, it is not memory, it is padding.

### Three tiers of memory

**Tier 1: Episodic (raw events).** `draft_analyses`, `sessions`, and `suggestions`. One immutable record per first-Enter analysis, one per prompt actually sent, and one per suggestion generated, with decisions and outcomes written back. This is the substrate, not the thing the agent reads at decision time.

**Tier 2: Derived (distilled facts).** `user_profile` and `block_library`. These are materialized from tier 1 on every outcome write, and they are what the agent actually consults. This is where "learned something last time" lives in a form that is cheap to read and directly actionable.

**Tier 3: Working (in-flight).** `checkpoints`, managed by `MongoDBSaver`. Per-session graph state, keyed by `thread_id`.

### What each memory read changes

| Memory read | Consumed by | What it changes |
|---|---|---|
| `user_profile.cost_quantiles.p40` | gate | Whether the agent runs at all. Threshold is the user's own distribution, not a constant. |
| `block_library` hash hit | gate, retrieve | A known recurring block triggers a deterministic collapse suggestion and **skips the LLM entirely**. Control flow, not context. |
| `user_profile.accept_rate_by_type` | reason | Which suggestion types are permitted in the action space. Types below ~0.15 acceptance are removed from the menu the LLM is allowed to pick from. |
| Expected savings for this prompt shape | reason | Which model gets called. Low expected upside routes to the cheap model, high upside routes to the strong one. |
| `user_profile.calibration` residuals | rescore | The predicted savings number itself, via a per-project bias correction. |
| `user_profile.completion_ratio_median` | featurizer | Imputed values for model features that are only observable after execution. |
| `accept_rate_by_type` again | package | Ranking is expected value (`predicted_savings * P(accept)`), not raw savings. Changes ordering and what gets truncated. |
| Checkpoint thread state | all nodes | Resume point after failure, and follow-up turns in the same session reuse the prior `retrieved_examples` instead of re-querying. |
| Vector-similar accepted suggestions | reason | Few-shot grounding. This is the one legitimately prompt-shaped use, and it is the smallest part of the story. |

### The block library, specifically

This is the mechanic that makes "does not relearn from scratch" concrete without any training loop.

On every prompt seen, normalize whitespace and hash each fenced code block and each 20-line sliding window. Match hashes against `block_library` for that user and project. When a block recurs, increment `occurrences`. Once a block has been seen three or more times and collapsing it has been accepted at least once, the gate node can propose the collapse directly with a known token count, no LLM call, no vector search.

Session 1 costs an LLM call to discover that the user keeps pasting the same 400-line schema. Session 12 recognizes it by hash in single-digit milliseconds and already knows the user accepts that rewrite. That is the difference between memory and logging, and it is inspectable in the database.

### The profile update path

`user_profile` is updated inside the same write as `record_outcome`, as one aggregation pipeline update. No batch job, no scheduled recompute, nothing that can silently fall behind:

```
{ _id: user_id,
  cost_quantiles: {p40, p50, p90},
  per_project: { <project>: {cost_quantiles, calibration} },
  accept_rate_by_type: {dedupe: 0.71, trim_boilerplate: 0.12, ...},
  calibration: {bias, mae, n},
  completion_ratio_median: 0.34,
  updated_at }
```

Keep counts alongside every rate so early values can be shrunk toward a global prior. With `n=2`, an acceptance rate of 1.0 should not be allowed to ban or promote anything.

---

## 3. Phase 0 — Contracts

Budget: 1 to 1.5 hours, done by one person. Nothing else starts until this is committed.

### 3.1 Repo skeleton

```
tokenlens-agent/
  cli/
    app.py               # terminal composer and state transitions
    state.py             # draft/analyzing/review/ready/sending contract
    renderer.py          # cost, suggestions, and Claude stream rendering
    claude_client.py     # safe argv invocation and session resume
  optimization_service.py # in-process cost/suggestion event stream
  mcp_server.py
  agent/
    graph.py
    state.py
    nodes/{gate,retrieve,reason,rescore,package}.py
  model/
    featurizer.py
    predictor.py
    booster.txt          # existing trained LightGBM model
  db/
    client.py
    repo.py              # every Mongo read/write lives here, nowhere else
    profile.py           # derived-tier materialization
    blocks.py            # hashing and block library
    indexes.py
    backfill.py
  scripts/
    run_local.py         # invoke graph directly, no MCP
  tests/
  .mcp.json              # optional Claude Code diagnostic MCP configuration
  CLAUDE.md              # prevents duplicate optimization inside Claude
  .env.example
```

Rule: **no module talks to Mongo except `db/`, and no module loads the booster except `model/predictor.py`.** Everything else imports a function. This is what makes the parallel split safe.

### 3.2 The contracts

**A. Cost prediction (context-dependent, not prompt-only)**

The model consumes prompt-derived features and context features together, so the prediction entry point takes both:

```python
# model/predictor.py
def predict(prompt: str, ctx: PredictionContext) -> CostBand
def predict_many(prompts: list[str], ctx: PredictionContext) -> list[CostBand]
```

```python
PredictionContext = {
    "user_id": str, "session_id": str, "project": str | None,
    "target_model": str,              # which LLM the prompt is bound for
    "session_turn_index": int,
    "recent_costs": list[float],      # from sessions
    "completion_ratio_median": float, # from user_profile, used for imputation
    "calibration_bias": float,        # from user_profile, applied post-predict
}
```

`ctx` is assembled once by the gate node and carried in graph state for the rest of the run. Two rules follow from this and they matter more than anything else in the model layer:

1. **`ctx` is held fixed between gate and rescore.** The savings delta is a counterfactual over prompt-derived features only. If any context feature drifts between the two calls, the delta is measuring the wrong thing.
2. **Features that are only observable post-execution are imputed from memory, never dropped silently.** If the model was trained with completion-side features, they get filled from `user_profile.completion_ratio_median` for that project, and the imputation is identical at both call sites. Enumerate exactly which features these are during phase 0 and write the list into `featurizer.py` as a module-level constant.

**B. Graph state**

```python
class AgentState(TypedDict):
    prompt: str
    session_id: str
    ctx: PredictionContext
    profile: UserProfile
    block_hits: list[BlockHit]
    predicted_cost: CostBand | None
    retrieved_examples: list[RetrievedExample]
    allowed_types: list[str]
    candidate_rewrites: list[CandidateRewrite]
    scored_rewrites: list[ScoredRewrite]
    route: Literal["full", "deterministic", "skip"]
```

Nodes only add keys. No node mutates a key another node wrote.

**C. Composer state and analysis events**

```python
class ComposerState(TypedDict):
    phase: Literal["draft", "analyzing", "review", "ready", "sending"]
    draft_text: str
    draft_version: int
    analysis_id: str | None
    analyzed_prompt_hash: str | None
    original_cost: CostBand | None
    suggestions: list[ScoredRewrite]
    decision: Literal["accepted", "skipped"] | None
    selected_prompt: str | None
    selected_prompt_hash: str | None
    claude_session_id: str | None

class CostReady(TypedDict):
    analysis_id: str
    draft_version: int
    prompt_hash: str
    cost: CostBand

class SuggestionsReady(TypedDict):
    analysis_id: str
    draft_version: int
    prompt_hash: str
    suggestions: list[ScoredRewrite]
```

All transition functions are pure and unit tested. The only function allowed to
call `ClaudeClient.send()` accepts a state whose phase is `ready` and revalidates
the prompt hash immediately before changing it to `sending`.

**D. Repository interface**

```python
# db/repo.py
def load_context(user_id, session_id, project) -> tuple[PredictionContext, UserProfile]
def match_blocks(prompt, user_id, project) -> list[BlockHit]
def log_session(prompt, predicted_cost, ctx) -> str
def find_similar(prompt, user_id, k=3) -> list[RetrievedExample]
def log_suggestions(session_id, rewrites) -> list[str]
def log_draft_analysis(analysis) -> str
def record_decision(analysis_id, decision, selected_prompt_hash) -> None
def record_send_result(analysis_id, claude_session_id, usage, error=None) -> None
def record_outcome(suggestion_id, accepted, actual_savings) -> None
```

`load_context` is a single call returning everything the graph needs from the derived tier, so the graph makes one read at the top rather than scattered lookups per node.

**E. In-process service and optional MCP surface**

The wrapper consumes an event stream so cost can render before suggestions:

```python
async def analyze_draft(request: AnalyzeDraftRequest) -> AsyncIterator[
    CostReady | SuggestionsReady | AnalysisFailed
]
```

The optional MCP adapter exposes two tools for diagnostics and feedback from
prompts that did not use the wrapper:

```
optimize_prompt(prompt, session_id?) -> {suggestions[], original_predicted_cost}
record_outcome(suggestion_id, accepted, final_prompt?) -> {ok}
```

### 3.3 Stub flag

`TOKENLENS_STUB=1` makes `predict`, `load_context`, `find_similar`, and the LLM call return fixtures. Commit the fixtures. This lets Agent C build the graph before A and B finish.

---

## 4. The four build agents

Each block is sized for its own Claude Code session, with the contracts file in context.

---

### Agent A — Model and feature service

**Owns:** `model/featurizer.py`, `model/predictor.py`, `tests/test_predictor.py`

**Must not touch:** `agent/`, `db/`, `mcp_server.py`

**Job:**
1. Load the booster once at import, cached at module level. Cold-loading per call is visible latency.
2. Split the training feature list into three buckets and write the split down: prompt-derived (length, line count, fenced-block count, duplicate-line ratio, repeated-block token share, path-token count, whitespace ratio), context-derived (target model, project, turn index, recent cost stats), and post-execution-only. Bucket three gets imputed from `ctx`, identically at both call sites.
3. Implement `predict_many` as a genuine batch call. Rescore passes 2 to 4 candidates and one batched inference is meaningfully faster than a loop.
4. Apply `ctx["calibration_bias"]` as a post-prediction correction, and keep it outside the booster so it can be updated per outcome without retraining.
5. Assert feature-vector parity: a test that builds the vector for the same prompt under the same `ctx` twice through both entry points and asserts equality. This is the counterfactual guarantee, and it is worth an explicit test because a silent mismatch produces plausible-looking wrong numbers.

**Done when:** a test asserts that a prompt containing an obviously duplicated 200-line block scores higher than its deduplicated version under identical `ctx`, and that `predict` returns in under 50ms warm.

---

### Agent B — Data and context layer

**Owns:** `db/*`, Atlas cluster config, `db/backfill.py`

**Must not touch:** `agent/`, `model/`, `mcp_server.py`

**Job:**
1. Create the cluster and seven collections: `draft_analyses`, `sessions`, `prompt_embeddings`, `suggestions`, `user_profile`, `block_library`, `checkpoints`.
2. Stand up the vector index with Automated Embeddings on `sessions.prompt_text` **first, before writing query code.** Index builds are not instant and the backfill needs documents present.
3. `find_similar` as a `$vectorSearch` aggregation joining through to `suggestions`, filtered to `accepted: true` and `actual_savings > 0`, scoped to the user. Retrieval that surfaces rejected suggestions actively degrades the reason node.
4. `db/blocks.py`: normalize, hash fenced blocks and 20-line windows, upsert into `block_library` with occurrence counts. Deterministic and cheap, called on every prompt.
5. `db/profile.py`: the single aggregation-pipeline update that recomputes quantiles, acceptance rates, and calibration residuals inside the `record_outcome` write. Store counts next to every rate and shrink toward a global prior below `n=10`.
6. `db/backfill.py`: replay existing TokenLens session history into `sessions`, `block_library`, and `user_profile`. The derived tier is only useful once it has been populated, and there is no reason for the agent to start blind when the history already exists.
7. Indexes: unique on `draft_analyses.analysis_id`, compound on `draft_analyses.{user_id, created_at}`, compound on `suggestions.session_id`, compound on `block_library.{user_id, block_hash}`, TTL on `checkpoints` at 24h.

**Done when:** `python -m db.backfill && python -c "from db.repo import load_context; print(load_context(...))"` returns populated quantiles and non-empty `accept_rate_by_type`, and a repeated prompt produces a `block_library` occurrence count above 1.

---

### Agent C — LangGraph orchestrator

**Owns:** `agent/graph.py`, `agent/state.py`, `agent/nodes/*`

**Must not touch:** internals of `db/repo.py` or `model/predictor.py`

**Job:** build against stubs, node by node, in this order. Each node is its own commit with `run_local.py` passing.

1. **`package`** first, so there is a runnable graph after node one. Ranks by `estimated_savings * P(accept | type)` from the profile, truncates to top 3.
2. **`gate`.** Calls `load_context`, then `match_blocks`, then `predict`. Sets `route`:
   - `skip` if p50 falls below the user's `cost_quantiles.p40` or a hard floor of ~400 tokens.
   - `deterministic` if a block hit has `occurrences >= 3` and `collapse_accepted >= 1`. Routes straight to rescore with a pre-built rewrite, no retrieval and no LLM.
   - `full` otherwise.
   This conditional edge is what makes the system an agent rather than a linear pipeline, and both non-`full` branches are driven entirely by stored state.
3. **`retrieve`.** `find_similar(k=3)`, and computes `allowed_types` by removing suggestion types whose acceptance rate is below threshold with sufficient `n`. Handles the empty case by falling back to the full type menu.
4. **`reason`.** OpenRouter through `langchain-openai` with `base_url` overridden. Constrain output to a JSON array of `{rewrite, rationale, suggestion_type}`, validate with Pydantic, retry once on parse failure, cap at 3 candidates. `suggestion_type` must be drawn from `allowed_types`, enforced in code rather than only requested in the prompt. Retrieved examples go in the system message with their real savings numbers attached.
5. **`rescore`.** `predict_many(candidates, ctx)` with the same `ctx` object from state. `estimated_savings = original.p50 - candidate.p50`. Drop any candidate at or below zero savings.

**Compile with the checkpointer:**
```python
graph.compile(checkpointer=MongoDBSaver(client, db_name="tokenlens"))
```
Every invocation needs `config={"configurable": {"thread_id": session_id}}`. A missing `thread_id` is the standard first-run failure. Reuse the same `thread_id` across turns in one editing session so follow-up calls resume with `retrieved_examples` already in state instead of re-querying.

**Done when:** `run_local.py` prints ranked suggestions with savings numbers; a prompt containing a known library block takes the `deterministic` route with zero LLM calls; killing the process mid-`reason` and re-invoking with the same `session_id` resumes from `retrieve` output.

---

### Agent D — Pre-send CLI, Claude handoff, and optional MCP

**Owns:** `cli/*`, `optimization_service.py`, `mcp_server.py`, `.mcp.json`,
`CLAUDE.md`, and pre-send integration tests

**Must not touch:** anything under `agent/` beyond invoking the compiled graph

**Job:**
1. Build `tokenlens-claude` with a multiline prompt buffer and explicit state
   renderer. Enter analyzes in `draft` and sends only in `ready`.
2. Implement pure state transitions plus exact-byte SHA-256 hashing. Editing in
   `review` or `ready` must synchronously clear the prior decision.
3. Consume `analyze_draft` events. Render `CostReady` immediately and accept
   `SuggestionsReady` only when all three identity fields still match.
4. Implement Accept 1/2/3 and Skip. Accept copies the rewrite into the visible
   buffer; both choices freeze the selected hash. An edit restarts the loop.
5. Implement `ClaudeClient` with `asyncio.create_subprocess_exec`, structured
   streaming output, no shell, fixed `cwd`, captured session ID, and explicit
   resume. Never automatically retry a failed send.
6. Persist analysis, decision, send result, and actual usage through `db/repo.py`.
   Treat edits as abandoned analyses, not rejected suggestions.
7. Add integration tests with fake optimization and Claude subprocesses proving:
   first Enter never invokes Claude; Accept and Skip each require second Enter;
   edits invalidate readiness; stale events are ignored; double Enter while
   analyzing cannot send; and one approved action results in at most one send.
8. Keep FastMCP as an optional adapter over the same graph. Update `CLAUDE.md` so
   a wrapper-launched prompt is not optimized again inside Claude.
9. Verify real Claude print-mode streaming and session resume after all fake
   subprocess tests pass.

**Done when:** a prompt cannot reach Claude before first Enter, an explicit
Accept/Skip, and second Enter; editing forces a fresh analysis; cost appears
before suggestions; the approved prompt reaches Claude exactly once; and a
follow-up approved prompt resumes the captured Claude session.

---

## 5. Phase order

Roughly 20 hours. After phase 1, A and B run independently, C swaps stubs for real implementations as they land, and D returns in phase 5 to replace the fake Claude client and persist real outcomes.

| Phase | What lands | Gate to next phase | Est. |
|---|---|---|---|
| **0. Contracts** | Skeleton, schemas, feature-bucket split, stubs, fixtures | Everything imports, stubs return fixtures | 1.5h |
| **1. Pre-send skeleton** | Wrapper state machine, fake cost/suggestions, fake Claude client | First Enter analyzes; Accept/Skip plus second Enter sends once | 3h |
| **2. Real model** | Agent A complete, gate and rescore share one `ctx` | Savings deltas are real and parity test passes | 3.5h |
| **3. Real memory** | Agent B complete, vector index live, backfilled, profile and block library populated | `load_context` returns real quantiles and rates | 4h |
| **4. Behavior-changing reads** | `route` branching live, `allowed_types` filtering live, EV ranking live | A known block skips the LLM; a low-acceptance type never appears | 2.5h |
| **5. Claude handoff + feedback** | Real stream-json client, session resume, decision/outcome writes | Approved prompt sends once; next turn resumes; profile changes | 3h |
| **6. Hardening** | Edit races, stale-result tests, crash handling, timeouts, empty retrieval | No stale or unapproved prompt can send under failure tests | 2.5h |

**Phase 1 proves the required user-safety flow; phase 4 proves that memory changes behavior.** Neither can be cut. Phases 0 through 3 establish contracts, cost prediction, and retrieval; phase 4 makes stored context alter routing and suggestions; phase 5 completes the real Claude handoff and learning loop. If time compresses, reduce optional MCP work before weakening the pre-send gate or behavior-changing reads.

---

## 6. Risks, ranked by likelihood of biting

**1. The prompt crosses the Claude boundary too early.** An MCP call chosen by
Claude occurs after submission and cannot save the current turn. Mitigation: the
wrapper owns the composer, the only Claude invocation is guarded by `ready`, and
tests fail if first Enter starts a Claude subprocess.

**2. A stale suggestion is accepted after an edit.** Async work can finish after
the draft changes. Mitigation: tag every event with analysis ID, version, and
hash; clear readiness synchronously on edit; verify the visible hash again on
second Enter.

**3. Feature-space drift between gate and rescore.** The model is context-dependent, so the savings number is only meaningful if every non-prompt feature is byte-identical across the two calls. Anything that recomputes `ctx` inside `rescore`, or imputes post-execution features differently at the two call sites, produces confident wrong numbers with no error. Mitigation: assemble `ctx` exactly once in `gate`, carry it in state, and keep the parity test from Agent A green.

**4. Claude delivery is ambiguous after a transport failure.** Blind retry can
duplicate a task. Mitigation: persist send attempt IDs, never retry automatically,
show the failure, and require explicit confirmation. Where the CLI exposes a
session/result ID, use it to reconcile before retrying.

**5. Vector index timing.** Atlas index builds and Automated Embeddings backfill take time and need documents present. Do the index and the backfill in phase 0 or early phase 1, even though retrieval is not wired until phase 3.

**6. Empty derived tier.** Until `user_profile` and `block_library` have content, gate falls back to the hard floor, `allowed_types` is unfiltered, and EV ranking degrades to raw savings. That path needs to work, but the system is uninteresting there. Run `backfill.py` against real session history early so the derived tier starts populated.

**7. Latency.** Vector search plus an OpenRouter round trip plus two inference calls can exceed 8 seconds. Batch the rescore call, cap candidates at 3, truncate retrieved examples to about 200 characters each, and emit the gate node's cost band as a partial result immediately so something appears within roughly 300ms. The `deterministic` route should return in well under a second, which is also the clearest evidence that memory is doing work.

**8. Scope creep.** Fireworks as a second gate-node model is explicitly optional in the architecture doc. Skip unless everything else is finished. Same for retraining the booster from logged outcomes: the calibration bias term already captures most of the value at a fraction of the cost.

---

## 7. First four commits

1. `chore: repo skeleton, state schema, repo interface, feature buckets, stub fixtures`
2. `feat: langgraph graph with five stubbed nodes and run_local script`
3. `feat: pre-send state machine with fake optimizer and Claude client`
4. `feat: display cost and require Accept or Skip before Claude handoff`

After commit four the required two-Enter path runs end to end on fake data, and
every remaining task replaces one stub without weakening the send invariant.
