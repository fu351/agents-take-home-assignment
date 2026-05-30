import { getToolCallsForItem, withItemContext } from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";
import { classify } from "./triage/classify.js";
import { extractFactsDeterministic, mergeFacts } from "./triage/extract.js";
import { extractFactsLLM, isLLMEnabled } from "./triage/llm.js";
import { orchestrateTools } from "./triage/orchestrate.js";
import { buildOutputItem } from "./triage/output.js";
import { assessSafety } from "./triage/safety.js";

/**
 * Triage the Monday inbox. Each item is processed in isolation: a thrown error
 * yields a thin-but-valid fallback output rather than aborting the batch, and
 * any tool calls already recorded for that item are still surfaced for audit.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const outputs: ItemOutput[] = [];
  for (const item of inbox) {
    outputs.push(await processItemSafely(item));
  }
  return outputs;
}

async function processItemSafely(item: InboxItem): Promise<ItemOutput> {
  try {
    return await withItemContext(item.id, () => processItem(item));
  } catch (error) {
    return buildFallbackOutput(item, error);
  }
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  // 1. Understand (deterministic; optional LLM enrich, merged).
  const base = extractFactsDeterministic(item);
  const enriched = isLLMEnabled() ? await extractFactsLLM(item) : null;
  const facts = mergeFacts(base, enriched);

  // 2. Assess safety (rule ∪ llm signals; monotonic, escalate-only).
  const safety = assessSafety(facts);

  // 3. Classify (category + urgency; default P2).
  const classification = classify(facts, safety);

  // 4. Orchestrate tools (conditional, data-dependent).
  const ctx = await orchestrateTools(item, facts, classification);

  // 5. Map to the output schema.
  return buildOutputItem(item, facts, safety, classification, ctx);
}

function buildFallbackOutput(item: InboxItem, error: unknown): ItemOutput {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["automated triage failed; manual review needed"],
    // Surface any calls already recorded for this item so the trace stays consistent.
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: "Manually review this inbox item; automated triage failed.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Automated triage threw an error (${reason}); routed to human review at default P2.`,
  };
}
