import type { Classification } from "../types.js";
import type { ClassificationResult, Facts, SafetyAssessment } from "./types.js";

/**
 * Maps facts + safety into the schema `Classification` enum and an urgency.
 * Default is P2. Over-escalation is itself a failure mode, so a SOFT safety
 * flag never raises urgency by itself — it only adds a reviewer note (handled
 * in output.ts). Only a HARD safety signal forces P0.
 */
export function classify(facts: Facts, safety: SafetyAssessment): ClassificationResult {
  // Hard safety dominates everything.
  if (safety.tier === "hard") {
    return { classification: "safeguarding", urgency: "P0" };
  }

  const classification = toClassification(facts);

  // Same-day operational issues are P1.
  if (
    facts.sameDay &&
    (facts.intent === "scheduling" ||
      classification === "scheduling" ||
      facts.intent === "billing_question")
  ) {
    return { classification, urgency: "P1" };
  }

  // Low-priority admin / noise.
  if (facts.intent === "spam" || facts.intent === "fyi") {
    return { classification, urgency: "P3" };
  }

  // Everything else — normal intake / clinical-review / billing workflow.
  return { classification, urgency: "P2" };
}

function toClassification(facts: Facts): Classification {
  if (facts.isClinicalQuestion) return "clinical_question";

  switch (facts.intent) {
    case "missing_paperwork":
      return "missing_paperwork";
    case "scheduling":
      // A reschedule/cancel of an existing appointment is an existing-patient request.
      return "existing_patient_request";
    case "billing_question":
      return "billing_question";
    case "spam":
      return "spam";
    case "fyi":
      return "other";
    case "new_referral":
      return "new_referral";
    case "existing_patient_request":
      return "existing_patient_request";
    case "complaint":
      return "complaint";
    default:
      return "other";
  }
}
