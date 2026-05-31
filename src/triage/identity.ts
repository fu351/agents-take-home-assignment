import type { Patient } from "../types.js";

/**
 * Identity verdict for a search_patient result. The agent must NOT blindly
 * trust the first returned record: a loose name match can surface a different
 * child with the same name. We compare the referral's name/DOB against every
 * returned record and only trust a match that is genuinely corroborated.
 */
export type IdentityVerdict = "none" | "confirmed" | "conflict" | "ambiguous";

export interface IdentityResult {
  verdict: IdentityVerdict;
  /** The trusted chart id — set ONLY when verdict === "confirmed". */
  patientId: string | null;
  matchCount: number;
  /** Human-readable explanation, surfaced as a reviewer flag + in the rationale. */
  reason: string;
}

/** Generational suffixes are dropped before comparing names ("Jr." etc.). */
const SUFFIX_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv"]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // strip punctuation incl. periods/commas
    .split(/\s+/)
    .filter((t) => t.length > 0 && !SUFFIX_TOKENS.has(t));
}

/**
 * Names corroborate when the shorter token set is a subset of the longer one.
 * This is order-insensitive and tolerates generational suffixes ("Mateo
 * Ramirez" vs "Mateo Ramirez Jr.") and extra middle names ("Sam Rivers" vs
 * "Sam Andrew Rivers"). DOB equality is the hard identity gate in
 * verifyIdentity; the name only needs to NOT contradict.
 */
export function namesCorroborate(searched: string | null, record: string): boolean {
  if (!searched) return false;
  const a = nameTokens(searched);
  const b = nameTokens(record);
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  return shorter.every((t) => longerSet.has(t));
}

/**
 * Verify a search_patient result against what the referral actually said.
 * Strict by design, with the guardian/parent name as a second identifier used
 * to RESOLVE slight ambiguity in the child's name/DOB — never to weaken a
 * contradiction:
 *
 * - A DOB that disagrees yields "conflict" and wins over everything; a matching
 *   guardian must NOT override it (same guardian + different DOB is a sibling).
 * - When several records come back, a corroborating guardian can narrow them to
 *   a single candidate before judging.
 * - When the referral has no DOB to corroborate (name-only or age-only), a
 *   matching guardian provides the second identifier needed to confirm; without
 *   it the match stays "ambiguous".
 * - When the DOB matches but the child name does not corroborate, a matching
 *   guardian resolves the match to "confirmed".
 *
 * Generalized: compares the searched name/DOB/guardian against the returned
 * records structurally. It branches on no specific name, DOB, or patient id.
 */
export function verifyIdentity(
  searched: { name: string | null; dob: string | null; age: string | null; guardian?: string | null },
  matches: Patient[],
): IdentityResult {
  const matchCount = matches.length;
  const guardian = searched.guardian ?? null;

  // 1. No record at all → new/unverified patient (existing behavior).
  if (matchCount === 0) {
    return {
      verdict: "none",
      patientId: null,
      matchCount,
      reason: "No existing record matched; treat as a new/unverified patient.",
    };
  }

  // 2. Guardian tie-breaker: when several records match, a corroborating
  //    guardian name can narrow them to a single candidate to judge below.
  let candidates = matches;
  let narrowedByGuardian = false;
  if (matchCount > 1 && guardian) {
    const byGuardian = matches.filter((m) => namesCorroborate(guardian, m.guardian_name));
    if (byGuardian.length === 1) {
      candidates = byGuardian;
      narrowedByGuardian = true;
    }
  }

  // 3. DOB conflict is the strongest wrong-child signal and is decisive — the
  //    guardian never overrides it (a matching guardian with a different DOB is
  //    a sibling, not the same child).
  if (searched.dob) {
    const conflicting = candidates.find((m) => m.dob && m.dob !== searched.dob);
    if (conflicting) {
      return {
        verdict: "conflict",
        patientId: null,
        matchCount,
        reason: `Referral DOB ${searched.dob} does not match the returned record's DOB ${conflicting.dob} — likely a different child (possibly a sibling) with the same name.`,
      };
    }
  }

  // 4. Still more than one candidate (guardian could not narrow) → ambiguous.
  if (candidates.length > 1) {
    return {
      verdict: "ambiguous",
      patientId: null,
      matchCount,
      reason: `${matchCount} records matched and the guardian name did not uniquely resolve them; identity cannot be determined from the referral.`,
    };
  }

  // Exactly one candidate, no DOB conflict.
  const only = candidates[0];
  const nameOk = namesCorroborate(searched.name, only.name);
  const guardianOk = !!guardian && namesCorroborate(guardian, only.guardian_name);
  const dobOk = !!searched.dob && only.dob === searched.dob;
  const via = narrowedByGuardian ? " (guardian name selected this record among several)" : "";

  // 4a. DOB corroborates and the name agrees → confirmed.
  if (dobOk && nameOk) {
    return {
      verdict: "confirmed",
      patientId: only.patient_id,
      matchCount,
      reason: `Single record with matching DOB ${searched.dob} and corroborating name${via}.`,
    };
  }

  // 4b. DOB corroborates but the child name does not — the guardian name
  //     resolves it (e.g. a nickname or transcription difference in the child name).
  if (dobOk && guardianOk) {
    return {
      verdict: "confirmed",
      patientId: only.patient_id,
      matchCount,
      reason: `DOB ${searched.dob} matches and the guardian name corroborates, though the child name differed; resolved via guardian${via}.`,
    };
  }

  // 4c. No DOB to corroborate, but the child name AND the guardian name both
  //     agree → two independent identifiers resolve the match.
  if (!searched.dob && nameOk && guardianOk) {
    return {
      verdict: "confirmed",
      patientId: only.patient_id,
      matchCount,
      reason: `No DOB on the referral, but the child name and guardian name both corroborate; resolved via guardian${via}.`,
    };
  }

  // 4d. Not enough corroboration → unverified.
  if (!searched.dob) {
    const basis = searched.age
      ? "only a free-text age (which cannot be reconciled to an exact date of birth)"
      : "no date of birth";
    const guardianNote = guardian
      ? " and the guardian name did not corroborate"
      : " and no guardian name to corroborate";
    return {
      verdict: "ambiguous",
      patientId: null,
      matchCount,
      reason: `A record matched on name but the referral provided ${basis}${guardianNote}.`,
    };
  }
  return {
    verdict: "ambiguous",
    patientId: null,
    matchCount,
    reason: `A record matched the referral DOB ${searched.dob} but neither the child name nor the guardian name corroborated; confirm before attaching to the chart.`,
  };
}
