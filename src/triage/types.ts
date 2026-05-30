import type { Classification, Discipline, Urgency } from "../types.js";

/**
 * Coarse intent buckets derived from an inbox item. These drive the
 * orchestration tree; they are intentionally broader than the schema
 * `Classification` enum (which is what we emit).
 */
export type Intent =
  | "new_referral"
  | "existing_patient_request"
  | "scheduling"
  | "clinical_question"
  | "billing_question"
  | "missing_paperwork"
  | "complaint"
  | "spam"
  | "fyi"
  | "other";

/**
 * Everything the deterministic core (and optional LLM enrich) understands
 * about an item before any tool is called. Nothing here is item-specific or
 * hardcoded — it is produced by general extraction.
 */
export interface Facts {
  child_name: string | null;
  dob: string | null; // ISO date if a real DOB was found
  age: string | null; // free-text age if only an age was given
  parent_contact: string | null;
  discipline: Discipline[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
  language: "en" | "es";

  intent: Intent;
  isClinicalQuestion: boolean;
  wantsBooking: boolean;
  sameDay: boolean;
  missingCoreIntake: boolean;
  missing_info: string[];
  /** Whether the item looks like a referral (drives missing-core-intake). */
  hasReferralShape: boolean;

  /** Human-readable safety phrases spotted by rules and/or the LLM. */
  safetyCandidates: SafetyCandidate[];
}

export type SafetyTier = "hard" | "soft" | "none";

export interface SafetyCandidate {
  tier: "hard" | "soft";
  reason: string;
  source: "rule" | "llm";
}

export interface SafetyAssessment {
  tier: SafetyTier;
  reasons: string[];
  source: Array<"rule" | "llm">;
}

export interface ClassificationResult {
  classification: Classification;
  urgency: Urgency;
}

/** Which pre-vetted, advice-free draft template to render. */
export type DraftScenario =
  | "none"
  | "scheduling"
  | "oon_benefits"
  | "clinical_routing"
  | "intake_missing_info"
  | "same_day_reschedule"
  | "acknowledge";

export interface InsuranceResult {
  status: "in_network" | "out_of_network" | "expired" | "unknown";
  plan?: string;
  copay?: number;
  auth_required?: boolean;
  notes?: string;
}

/**
 * The outcome of running the orchestration tree: what side effects happened
 * and the data needed to render an evidence-linked rationale + draft.
 */
export interface DecisionContext {
  patientFound: boolean;
  patientId: string | null;
  insurance: InsuranceResult | null;
  insuranceDiscrepancy: string | null;
  slotsFound: number;
  heldSlot: { provider_name: string; start: string } | null;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  draftScenario: DraftScenario;
  /** Final, guarded draft body once rendered (null if no draft). */
  draftBody: string | null;
  /** Evidence fragments, joined into decision_rationale. */
  rationale: string[];
  /** Recipient + channel for the draft, when one is appropriate. */
  draftRecipient: string | null;
  draftChannel: "portal" | "email" | "phone" | null;
}
