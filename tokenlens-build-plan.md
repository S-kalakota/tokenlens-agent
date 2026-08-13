# TokenLens optimizer agent — build plan

Companion to `tokenlens-agent-architecture.md`. That doc says what the system is. This one says what gets built, by whom, in what order, and what has to be true before the next thing starts.

Two organizing ideas:

1. **Contracts before parallelism.** An hour of schema work up front lets four build agents run without stepping on each other. Skip it and the back half of the build is spent reconciling field names.
2. **Walking skeleton first.** Every layer ships a stub on day one so the full path (Claude Code CLI -> MCP -> graph -> response) runs end to end before any component is real. Then stubs get replaced one at a time.
3. **Companion, not coupling.** The agent is deployed beside TokenLens, not inside it. It owns its process, MongoDB collections, MCP surface, and configuration. TokenLens may later supply a booster artifact and exported session history, but neither codebase imports the other and the companion remains runnable with fixtures when those inputs are absent.

---

## 1. The context model

This is the part the brief is actually testing. Storing state is easy. The requirement is that what you store and retrieve **changes what the system does next**, not that it gets pasted into a prompt. So the design rule for this project is:

> Every read from Mongo must be attached to a decision the system would otherwise make differently. If a retrieved value only ever lands in a prompt string, it is not memory, it is padding.

### Three tiers of memory

**Tier 1: Episodic (raw events).** `sessions` and `suggestions`. One document per prompt seen, one per suggestion generated, with outcomes written back. Append-only. This is the substrate, not the thing the agent reads at decision time.

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

## 2. Phase 0 — Contracts

Budget: 1 to 1.5 hours, done by one person. Nothing else starts until this is committed.

### 2.1 Repo skeleton

```
tokenlens-agent/
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
  .mcp.json              # shared Claude Code project MCP configuration
  CLAUDE.md              # persistent instruction for when to call TokenLens
  .env.example
```

Rule: **no module talks to Mongo except `db/`, and no module loads the booster except `model/predictor.py`.** Everything else imports a function. This is what makes the parallel split safe.

### 2.2 The four contracts

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

**C. Repository interface**

```python
# db/repo.py
def load_context(user_id, session_id, project) -> tuple[PredictionContext, UserProfile]
def match_blocks(prompt, user_id, project) -> list[BlockHit]
def log_session(prompt, predicted_cost, ctx) -> str
def find_similar(prompt, user_id, k=3) -> list[RetrievedExample]
def log_suggestions(session_id, rewrites) -> list[str]
def record_outcome(suggestion_id, accepted, actual_savings) -> None   # also updates profile + blocks
```

`load_context` is a single call returning everything the graph needs from the derived tier, so the graph makes one read at the top rather than scattered lookups per node.

**D. MCP tool surface**

Two tools, not one. The architecture doc names only `optimize_prompt`, but the write-back path needs an entry point (see Risk 2):

```
optimize_prompt(prompt, session_id?) -> {suggestions[], original_predicted_cost}
record_outcome(suggestion_id, accepted, final_prompt?) -> {ok}
```

### 2.3 Stub flag

`TOKENLENS_STUB=1` makes `predict`, `load_context`, `find_similar`, and the LLM call return fixtures. Commit the fixtures. This lets Agent C build the graph before A and B finish.

---

## 3. The four build agents

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
1. Create the cluster and six collections: `sessions`, `prompt_embeddings`, `suggestions`, `user_profile`, `block_library`, `checkpoints`.
2. Stand up the vector index with Automated Embeddings on `sessions.prompt_text` **first, before writing query code.** Index builds are not instant and the backfill needs documents present.
3. `find_similar` as a `$vectorSearch` aggregation joining through to `suggestions`, filtered to `accepted: true` and `actual_savings > 0`, scoped to the user. Retrieval that surfaces rejected suggestions actively degrades the reason node.
4. `db/blocks.py`: normalize, hash fenced blocks and 20-line windows, upsert into `block_library` with occurrence counts. Deterministic and cheap, called on every prompt.
5. `db/profile.py`: the single aggregation-pipeline update that recomputes quantiles, acceptance rates, and calibration residuals inside the `record_outcome` write. Store counts next to every rate and shrink toward a global prior below `n=10`.
6. `db/backfill.py`: replay existing TokenLens session history into `sessions`, `block_library`, and `user_profile`. The derived tier is only useful once it has been populated, and there is no reason for the agent to start blind when the history already exists.
7. Indexes: compound on `suggestions.session_id`, compound on `block_library.{user_id, block_hash}`, TTL on `checkpoints` at 24h.

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

### Agent D — MCP server and Claude Code integration

**Owns:** `mcp_server.py`, `.mcp.json`, `CLAUDE.md`

**Must not touch:** anything under `agent/` beyond invoking the compiled graph

**Job:**
1. `fastmcp` wrapper exposing both tools. No logic, just invoke and return.
2. Write the tool descriptions deliberately. Claude Code uses those descriptions when deciding whether to call an MCP tool, so `optimize_prompt` should read as "call before sending a long or context-heavy prompt to estimate and reduce its token cost."
3. `record_outcome`'s description instructs the agent to call it once the user has accepted, edited, or ignored a rewrite. This is the write-back path into the derived tier, so it is load-bearing rather than telemetry.
4. Add a concise project-root `CLAUDE.md` rule instructing Claude Code to call `optimize_prompt` before acting on long or context-heavy prompts and to call `record_outcome` after the user accepts, edits, or rejects a rewrite. The MCP description supplies tool semantics; `CLAUDE.md` supplies the persistent project workflow.
5. Register the stdio server at project scope in `.mcp.json`. Use `${CLAUDE_PROJECT_DIR:-.}` in the server path so startup does not depend on the shell's working directory, default `TOKENLENS_STUB` to `1` until the real implementations land, and never place credentials directly in the committed file.
6. Verify with `claude mcp list`, `claude mcp get tokenlens`, and `/mcp` inside an interactive `claude` session. Approve the project server when Claude Code prompts on first use, then explicitly ask Claude to use TokenLens once before testing automatic invocation.
7. Add an `--http` mode alongside stdio. It is the fallback when local subprocess spawning misbehaves or the server later needs to run remotely; Claude Code supports streamable HTTP with `claude mcp add --transport http`.

**Done when:** `/mcp` reports TokenLens connected, a long prompt in Claude Code triggers `optimize_prompt` without explicit invocation, and an accepted rewrite causes Claude Code to call `record_outcome`, moving the corresponding `accept_rate_by_type` value.

---

## 4. Phase order

Roughly 16 to 18 hours. After phase 1, A and B run fully independently and C swaps stubs for real implementations as they land. D is idle between phase 1 and phase 5.

| Phase | What lands | Gate to next phase | Est. |
|---|---|---|---|
| **0. Contracts** | Skeleton, schemas, feature-bucket split, stubs, fixtures | Everything imports, stubs return fixtures | 1.5h |
| **1. Walking skeleton** | Five stubbed nodes, `run_local.py` runs, MCP tool callable from Claude Code | Fake suggestions appear in the CLI session | 2h |
| **2. Real model** | Agent A complete, gate and rescore share one `ctx` | Savings deltas are real and parity test passes | 3.5h |
| **3. Real memory** | Agent B complete, vector index live, backfilled, profile and block library populated | `load_context` returns real quantiles and rates | 4h |
| **4. Behavior-changing reads** | `route` branching live, `allowed_types` filtering live, EV ranking live | A known block skips the LLM; a low-acceptance type never appears | 2.5h |
| **5. Feedback loop** | `record_outcome` wired end to end, profile updates inside the same write | Accept a rewrite, watch `accept_rate_by_type` and `block_library` move | 2h |
| **6. Hardening** | Crash-resume verified, timeouts, empty-retrieval path, error surfaces | Kill mid-run, resume correctly | 2h |

**Phase 4 is the phase that answers the brief.** Phases 0 through 3 build a system that stores and retrieves; phase 4 is where retrieval starts changing control flow. If time compresses, cut hardening, not phase 4.

---

## 5. Risks, ranked by likelihood of biting

**1. Feature-space drift between gate and rescore.** The model is context-dependent, so the savings number is only meaningful if every non-prompt feature is byte-identical across the two calls. Anything that recomputes `ctx` inside `rescore`, or imputes post-execution features differently at the two call sites, produces confident wrong numbers with no error. Mitigation: assemble `ctx` exactly once in `gate`, carry it in state, and keep the parity test from Agent A green.

**2. There is no accept/reject callback in MCP.** Nothing in the protocol notifies the server when a user takes a suggestion. Options in order of preference: (a) expose `record_outcome` as a tool and instruct Claude Code to call it through both the tool description and `CLAUDE.md`, which is explicit but not guaranteed; (b) infer acceptance by comparing the next prompt in the session against the suggested rewrite above a similarity threshold; (c) wrap scripted `claude -p` invocations when a guaranteed machine-readable feedback path is required. Implement (a), run (b) as a background heuristic so the derived tier still learns when (a) is skipped.

**3. Vector index timing.** Atlas index builds and Automated Embeddings backfill take time and need documents present. Do the index and the backfill in phase 0 or early phase 1, even though retrieval is not wired until phase 3.

**4. Empty derived tier.** Until `user_profile` and `block_library` have content, gate falls back to the hard floor, `allowed_types` is unfiltered, and EV ranking degrades to raw savings. That path needs to work, but the system is uninteresting there. Run `backfill.py` against real session history early so the derived tier starts populated.

**5. Latency.** Vector search plus an OpenRouter round trip plus two inference calls can exceed 8 seconds. Batch the rescore call, cap candidates at 3, truncate retrieved examples to about 200 characters each, and return the gate node's cost band as a partial result immediately so something appears within roughly 300ms. The `deterministic` route should return in well under a second, which is also the clearest evidence that memory is doing work.

**6. Scope creep.** Fireworks as a second gate-node model is explicitly optional in the architecture doc. Skip unless everything else is finished. Same for retraining the booster from logged outcomes: the calibration bias term already captures most of the value at a fraction of the cost.

---

## 6. First three commits

1. `chore: repo skeleton, state schema, repo interface, feature buckets, stub fixtures`
2. `feat: langgraph graph with five stubbed nodes and run_local script`
3. `feat: expose TokenLens MCP tools to Claude Code via .mcp.json`

After commit three the full path runs end to end on fake data, and every remaining task is replacing one stub with one real implementation. That property is worth protecting.
