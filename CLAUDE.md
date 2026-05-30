# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A take-home assignment: build a **Referral Inbox Triage Agent** for a fictional pediatric therapy practice (Cedar Kids Therapy). The agent reads a batch of `InboxItem[]` (fax referrals, voicemails, portal messages, emails), uses the provided tools to investigate, and emits one structured, human-reviewable `ItemOutput` per inbox item.

**The only code you implement is `runAgent(inbox)` in `src/agent.ts`** — it currently throws a TODO. Everything else is fixed scaffolding: `src/index.ts` (CLI + I/O), `src/tools.ts` (tools + audit trace), `src/validate.ts` (acceptance check), `src/types.ts` (contracts). **Do not modify, reimplement, or bypass `src/tools.ts`** — the tools build the audit trace the validator checks, so bypassing them fails validation. You may add helper modules and install a provider SDK (e.g. `openai` or `@anthropic-ai/sdk`); runtime LLM use is allowed but optional (key via env var, never committed).

## Commands

```bash
npm install
npm run triage     # runs src/index.ts: reads data/inbox.json, writes output.json + .trace/tool-calls.jsonl
npm run validate   # acceptance gate — must pass; cross-checks output.json against the trace
npm run typecheck  # tsc --noEmit, type gate
```

There is **no unit-test suite or single-test runner**. `npm run validate` is the de facto acceptance test — it must pass. Both `triage` and `validate` accept optional `--input`, `--output`, `--trace` flags and default to the paths above; never hardcode those paths, since reviewers run the same commands against **hidden synthetic variants**.

## The audit-trace contract (spans index → tools → validator)

This is the core architecture and the easiest thing to get wrong:

1. `src/index.ts` calls `configureTrace()` before `runAgent`. Calling any tool before this throws `TraceNotConfigured`.
2. **Every item-level tool call must run inside `withItemContext(item.id, async () => …)`.** `recordTool` reads the item id from `AsyncLocalStorage`; calling a tool outside that context throws `ToolCallOutsideItemContext`.
3. Build each item's `tools_called[]` from **`getToolCallsForItem(item.id)`, passed through unchanged** — do not synthesize, edit, or reorder tool-call objects. Each tool also returns its own `ToolResult` (with `call_id` + `data`) for use in your decision logic.
4. `validateTraceMatch` cross-checks every reported `call_id` against `.trace/tool-calls.jsonl` by name, canonicalized args, and `result_summary`, and requires every non-exempt trace entry to surface in output **exactly once**, under the item it belongs to.
5. **Never copy the `example_*` call_ids / task_ids from `data/example_output.json`** — those IDs aren't in the trace, so the validator rejects them. Use only what the tools return.
6. `src/index.ts` wraps your items with `buildBatchOutput()`; let it compute the summary counts — do not hand-compute them.

## Non-obvious validator rules (beyond the JSON schema)

`schema/output.schema.json` is the shape source of truth, but `src/validate.ts` adds rules the schema doesn't express:

- **`requires_human_review` must be `true` for every item.** The schema allows any boolean, but `validateHumanReview` makes it effectively constant: the whole batch is human-reviewable, nothing is auto-actioned.
- **At least 3 distinct tool names across the batch** (`validateToolThreshold`). Strong solutions use tools as part of the decision process across items, not once to clear the bar; performative calls are penalized.
- **Exactly one output item per input id** (`validateItemCoverage`) — no missing, unknown, or duplicate ids.
- The tools `schedule_appointment` and `send_message` are **forbidden** and do not exist. Do not auto-send (`draft_message` only) and do not schedule (`find_slots` / `hold_slot` produce reviewable holds only).

## Tools (in `src/tools.ts`)

All tools are **deterministic stubs** over the fixtures in `data/`. Treat their fixture values as test data, not as a spec:

- `search_patient` — match against existing-patient records.
- `verify_insurance` — keyword match returning `in_network` / `out_of_network` / `expired` / `unknown` (plus copay / auth flags).
- `lookup_policy(topic)` — returns policy snippets per `PolicyTopic`; snippets are hardcoded to mirror `data/policies.md`.
- `find_slots` — reads `data/providers.json`, filters out `full` caseloads, then by discipline/language.
- `hold_slot`, `create_task`, `draft_message`, `escalate` — produce reviewable artifacts with generated ids.

**Generalize; do not overfit.** Reviewers run hidden variants, so do not branch on the specific item ids, names, DOBs, or payer strings visible in the fixtures. Look up the exact fixture behavior in `src/tools.ts` when you need it.

## Domain rules (from README + `data/policies.md`)

Urgency calibration — default to **P2** unless there's a clear safety or same-day reason; over-escalation is itself a failure mode:

| Level | Meaning |
|-------|---------|
| P0 | Safeguarding / imminent harm / mandated-reporter escalation; same-hour review |
| P1 | Same-day operational issue needing prompt staff action |
| P2 | Normal intake, scheduling, billing, or clinical-review workflow (default) |
| P3 | Low-priority admin, FYI, spam |

Other domain constraints: verified billing status supersedes payer info on referral documents (surface the discrepancy); never give clinical advice in a draft (route to evaluation/clinician review); out-of-network requires a benefits conversation before any slot hold; draft replies should be clear, empathetic, concise, and must not imply a message was sent. Use only synthetic data — never add real PHI.

## Deliverables to commit

Your code, the updated `README.md` (it specifies six required sections), and the final generated `output.json`. Do **not** commit API keys, `.env`, `node_modules/`, or `.trace/` (all gitignored).
