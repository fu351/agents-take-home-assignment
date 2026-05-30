import { getToolCallsForItem } from "../tools.js";
import type { ExtractedIntake, InboxItem, ItemOutput } from "../types.js";
import type {
  ClassificationResult,
  DecisionContext,
  Facts,
  SafetyAssessment,
} from "./types.js";

/**
 * Strict mapping from internal objects to the output schema. `tools_called`
 * comes straight from getToolCallsForItem and is passed through unchanged so it
 * matches the audit trace exactly. Every item requires human review.
 */
export function buildOutputItem(
  item: InboxItem,
  facts: Facts,
  safety: SafetyAssessment,
  classification: ClassificationResult,
  ctx: DecisionContext,
): ItemOutput {
  const missing_info = [...facts.missing_info];

  // Surface a soft safety flag for the reviewer without escalating.
  if (safety.tier === "soft") {
    missing_info.push(`SAFETY FLAG (review): ${safety.reasons.join("; ")}`);
  }
  if (ctx.insuranceDiscrepancy) {
    missing_info.push(`INSURANCE DISCREPANCY: ${ctx.insuranceDiscrepancy}`);
  }

  return {
    item_id: item.id,
    classification: classification.classification,
    urgency: classification.urgency,
    requires_human_review: true,
    extracted_intake: toExtractedIntake(facts),
    missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: recommendedAction(classification, ctx, facts),
    draft_reply: ctx.draftBody,
    task_ids: ctx.task_ids,
    escalation: ctx.escalation,
    decision_rationale: buildRationale(classification, safety, ctx),
  };
}

function toExtractedIntake(facts: Facts): ExtractedIntake {
  return {
    child_name: facts.child_name,
    dob_or_age: facts.dob ?? facts.age,
    parent_contact: facts.parent_contact,
    discipline: facts.discipline && facts.discipline.length > 0 ? facts.discipline : null,
    diagnosis_or_concern: facts.diagnosis_or_concern,
    payer: facts.payer,
    member_id: facts.member_id,
  };
}

function recommendedAction(
  classification: ClassificationResult,
  ctx: DecisionContext,
  facts: Facts,
): string {
  if (classification.urgency === "P0") {
    return "Escalate to the clinical lead for same-hour safeguarding review and mandated-reporter steps. Do not contact the family with reassurance.";
  }
  switch (ctx.draftScenario) {
    case "oon_benefits":
      return "Billing should review out-of-network benefits with the family before any slot hold or scheduling.";
    case "clinical_routing":
      return "Route the clinical question to a clinician/evaluation; do not answer it over message.";
    case "intake_missing_info":
      return `Intake should obtain missing information (${facts.missing_info.join(", ")}) before scheduling.`;
    case "same_day_reschedule":
      return "Front desk should action the same-day reschedule and confirm a new time with the family today.";
    case "scheduling":
      return ctx.heldSlot
        ? "Confirm the reviewable hold with the family and finalize the evaluation appointment."
        : "Confirm details with the family and schedule an evaluation (offer waitlist if no slot).";
    default:
      return "Route to a human reviewer for triage.";
  }
}

function buildRationale(
  classification: ClassificationResult,
  safety: SafetyAssessment,
  ctx: DecisionContext,
): string {
  const lead = `${classification.urgency} / ${classification.classification}.`;
  const safetyNote =
    safety.tier === "hard"
      ? ` Hard safety signal (${safety.reasons.join("; ")}).`
      : safety.tier === "soft"
        ? ` Soft safety flag noted for reviewer (${safety.reasons.join("; ")}); did not auto-escalate.`
        : "";
  return `${lead}${safetyNote} ${ctx.rationale.join(" ")}`.trim();
}
