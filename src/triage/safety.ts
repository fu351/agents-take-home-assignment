import type { Facts, SafetyAssessment, SafetyTier } from "./types.js";

const TIER_RANK: Record<SafetyTier, number> = { none: 0, soft: 1, hard: 2 };

/**
 * Combine all safety candidates (deterministic rules + optional LLM) into a
 * single assessment. Trust is ASYMMETRIC and MONOTONIC: the final tier is the
 * maximum of every signal's tier. No automated signal can ever lower a flag —
 * only a human clears safety. This is what lets us promise in the README that
 * escalation is controlled by deterministic policy and cannot be de-escalated
 * by a model.
 */
export function assessSafety(facts: Facts): SafetyAssessment {
  let tier: SafetyTier = "none";
  const reasons: string[] = [];
  const source = new Set<"rule" | "llm">();

  for (const candidate of facts.safetyCandidates) {
    if (TIER_RANK[candidate.tier] > TIER_RANK[tier]) {
      tier = candidate.tier;
    }
    reasons.push(`${candidate.reason} (${candidate.source})`);
    source.add(candidate.source);
  }

  return { tier, reasons, source: [...source] };
}
