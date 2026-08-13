# TokenLens agent

This directory implements Parts 1 and 2 of `tokenlens-build-plan.md`: the
context-model data shapes, Phase 0 repository skeleton, stable cross-layer
contracts, feature buckets, and committed stubs.

## Phase 0 behavior

Set `TOKENLENS_STUB=1` to make these boundaries return committed fixtures:

- `model.predictor.predict` and `predict_many`
- `db.repo.load_context`
- `db.repo.find_similar`
- `agent.nodes.reason.call_reasoning_model`

Block fingerprinting and sparse acceptance-rate shrinkage are dependency-free
pure helpers. MongoDB writes, real LightGBM inference, graph orchestration, and
the FastMCP adapter remain explicit `NotImplementedError` boundaries because
they start in Part 3.

## Verify

From this directory:

```sh
TOKENLENS_STUB=1 python3 -m unittest discover -s tests
```

The placeholder `model/booster.txt` must be replaced with the existing trained
LightGBM export before real model work begins.
