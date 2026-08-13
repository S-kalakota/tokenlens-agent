# TokenLens optimizer agent — architecture reference

## What this agent does

Given a prompt (typed in Claude Code or pulled from a past session), the agent returns concrete rewrite suggestions that reduce token usage, each with a predicted savings number. It gets better over time because every accepted or rejected suggestion is logged, and future retrieval pulls from that history — this is the "no cold start" piece the hackathon theme asks for.

**Deployment boundary:** this agent runs alongside the existing TokenLens product as an independent Python/MCP service. It does not import, modify, or need the TokenLens application at runtime. The trained LightGBM booster and historical TokenLens sessions are optional integration inputs: when available they replace the placeholder booster and seed MongoDB; until then the agent can be developed and demonstrated with its committed fixtures.

## Where each piece lives

```
Claude Code CLI (`claude`)
      |
      v  MCP tool call: optimize_prompt(prompt)
MCP server (mcp_server.py)
      |
      v
LangGraph orchestrator (agent/graph.py)
   |-- gate node        --> LightGBM quantile model
   |-- retrieve node     --> MongoDB Atlas Vector Search
   |-- reason node       --> OpenRouter (Claude / other model)
   |-- rescore node      --> LightGBM quantile model
   |-- package node       --> returns suggestions to MCP server
      |
      v
MongoDB Atlas (sessions, prompt_embeddings, suggestions, checkpoints)
      |
      ^ feedback write-back on accept/reject
```

---

## 1. Claude Code CLI / MCP client

Claude Code connects to local tools through the Model Context Protocol. TokenLens is registered as a project-scoped stdio server in `.mcp.json` at the repository root, so the shared configuration can be committed without committing secrets. Claude Code asks the user to approve a project-scoped server the first time it is encountered.

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

Claude Code discovers the `optimize_prompt` tool from the MCP server. Its tool description tells Claude when the tool is relevant, while the repository-root `CLAUDE.md` adds an explicit project instruction to call TokenLens before sending a long or context-heavy prompt. A user can always invoke it directly by asking Claude to use TokenLens to optimize a prompt.

---

## 2. MCP server (`mcp_server.py`)

A thin wrapper, built with `fastmcp` (Python) or the TypeScript MCP SDK. Its only job is to expose your LangGraph agent as a callable tool with a defined schema:

```
optimize_prompt(prompt: str, session_id: str | None) -> {
  suggestions: [ { rewrite, estimated_savings, rationale } ],
  original_predicted_cost: { p10, p50, p90 }
}
```

It has no logic of its own — it invokes the LangGraph graph and returns its output. Keeping this layer dumb means you can test the agent directly (bypassing MCP) during development, then wire MCP on last.

---

## 3. LangGraph orchestrator (`agent/graph.py`)

This is the core. A graph of nodes with shared state, compiled with a MongoDB checkpointer so a crash mid-run doesn't lose progress — this directly matches the "state & persistence" pattern MongoDB provided as a reference resource.

**Nodes:**

- **gate** — runs the prompt through the LightGBM model first. If predicted cost is already low relative to the user's typical prompts, short-circuits and returns early. This is the cost-conscious pre-filter.
- **retrieve** — queries MongoDB Atlas Vector Search for the k most similar past prompts, and pulls whichever of their logged suggestions were actually accepted and reduced tokens. This is the memory step — it's what makes suggestions specific to this user's patterns instead of generic advice.
- **reason** — calls the LLM (via OpenRouter) with the current prompt plus the retrieved examples as grounding context, and asks it to propose specific rewrites (e.g. "collapse repeated file dump," "trim boilerplate instructions," "deduplicate context").
- **rescore** — runs each proposed rewrite back through the LightGBM model to get a real predicted cost, and computes the delta against the original. This replaces "trust the LLM's claim" with an actual quantitative estimate.
- **package** — formats the final suggestions object and returns it to the MCP server.

**State object** carried through the graph: `{ prompt, session_id, predicted_cost, retrieved_examples, candidate_rewrites, scored_rewrites }`.

**Checkpointing:** `langgraph-checkpoint-mongodb`'s `MongoDBSaver` is passed at graph compile time. Every node's state write is automatically persisted to the `checkpoints` collection — no manual read/write code needed.

---

## 4. LightGBM quantile model

The preferred production model is TokenLens's existing trained booster, supplied to this companion service as a versioned artifact rather than imported from the TokenLens runtime. Until that artifact is supplied, the committed placeholder keeps the boundary explicit. There are two call sites:

- **gate node** — scores the raw prompt as-is.
- **rescore node** — scores each candidate rewrite.

Both call sites use the same featurizer (whatever features the model was trained on: prompt length, structure signals, repeated-block counts, etc.) so the numbers are directly comparable — the delta between gate output and rescore output *is* the "estimated savings" shown to the user.

**Why it matters for judging:** it's the concrete technical differentiator. An LLM proposing "make this shorter" is generic; a trained model quantifying the actual predicted cost reduction is a real system, not a prompt-engineering demo.

**Future extension (not required for the hackathon, worth mentioning in the demo):** every real outcome logged in `suggestions` (predicted vs. actual token count) is training data for periodically retraining or recalibrating the model — closing the loop from "predicts" to "learns from being wrong."

---

## 5. MongoDB Atlas

Four collections, one cluster.

**`sessions`** — one document per prompt seen.
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

**`checkpoints`** — managed automatically by `MongoDBSaver`. You don't write to this directly.

---

## 6. LLM layer

**OpenRouter** is the primary path — one API key, one client (`langchain-openai` pointed at OpenRouter's base URL), and you can swap the underlying model without touching integration code. Used in the `reason` node.

**Fireworks** is optional, worth adding only if you want a second, cheaper/faster model specifically for the `gate` node's lightweight pre-checks, so the expensive reasoning model is reserved for prompts that actually need it.

---

## 7. Feedback loop

When the user accepts, rejects, or edits a suggestion in Claude Code, Claude calls the `record_outcome` MCP tool to update the corresponding `suggestions` document: `accepted` flag and `actual_savings` (measured from the real before/after token count). MCP does not emit a native acceptance event, so this explicit tool call is the primary write-back path and a next-prompt similarity heuristic is the fallback. The next time `retrieve` runs a similar query, it pulls from real outcomes rather than only LLM guesses — this is the entire "no cold start" claim made concrete and inspectable in the database.

---

## End-to-end trace of one call

1. User starts `claude` in the repository and enters a long or context-heavy request; Claude Code follows `CLAUDE.md` and calls `optimize_prompt`.
2. MCP server invokes the LangGraph graph with `{ prompt, session_id }`.
3. **gate**: LightGBM predicts cost. Not already low — proceed.
4. **retrieve**: Atlas Vector Search finds 3 similar past prompts; 2 of them have an accepted suggestion attached.
5. **reason**: OpenRouter call, grounded in those 2 examples, proposes 2 candidate rewrites.
6. **rescore**: LightGBM scores both rewrites; one saves ~340 tokens, the other ~90.
7. **package**: returns both, ranked by savings, with rationale text.
8. MCP server returns the result to Claude Code; the user sees it in the terminal session.
9. User accepts the 340-token rewrite. Claude Code calls `record_outcome`, which writes `accepted: true, actual_savings: 355` back to `suggestions`.
10. Checkpointer has already persisted every intermediate state to `checkpoints` throughout — if step 5 had crashed, a retry resumes from `retrieve`'s output rather than starting over.
