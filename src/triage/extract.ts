import type { Discipline, InboxItem } from "../types.js";
import type { Facts, Intent, SafetyCandidate } from "./types.js";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/;
const DOB_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const AGE_RE = /\b(?:is|age[d]?|tiene)?\s*(\d{1,2})\s*(?:years?\s*old|yo|year-old|años|anos|-year-old)\b/i;

/**
 * Label-style fields common in fax referrals: "DOB: ...", "Member ID: ...".
 * Stops at the next field separator (comma, semicolon, period, newline) so a
 * value never swallows the rest of a period-delimited referral line.
 */
function labelValue(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]\\s*([^\\n,;.]+)`, "i");
    const m = text.match(re);
    if (m) {
      const value = m[1].trim();
      if (value && !isBlank(value)) return value;
    }
  }
  return null;
}

/** Name patterns in free prose when no "Child:"/"Patient:" label is present. */
function detectNameProse(text: string): string | null {
  const NAME = "([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})";
  const patterns = [
    new RegExp(`referral for ${NAME}`),
    new RegExp(`(?:my|our)\\s+(?:son|daughter|child)\\s+${NAME}`),
    // "my 4-year-old Ava" / "our 6 year old Sam"
    new RegExp(`(?:my|our)\\s+\\d{1,2}[- ]?year[- ]?old\\s+${NAME}`),
    // "for Owen's evaluation"
    new RegExp(`\\bfor\\s+${NAME}'s\\b`),
    new RegExp(`\\bmi\\s+(?:hijo|hija)\\s+${NAME}`),
    new RegExp(`(?:por|para)\\s+(?:mi\\s+(?:hijo|hija)\\s+)?${NAME}`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  // Last resort: a capitalized given-name in possessive form, e.g. "Noah's DOB".
  const possessive = text.match(/\b([A-Z][a-z]+)'s\b/);
  if (possessive && possessive[1]) return possessive[1].trim();
  return null;
}

function isBlank(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "" || v === "[blank]" || v === "blank" || v === "n/a" || v === "none" || v === "unknown";
}

function detectDisciplines(text: string): Discipline[] | null {
  const t = text.toLowerCase();
  const found = new Set<Discipline>();
  if (/\bslp\b|speech|articulation|language therapy|speech-language|habla/.test(t)) found.add("SLP");
  if (/\bot\b|occupational|sensory|feeding|fine motor/.test(t)) found.add("OT");
  if (/\bpt\b|physical therapy|gross motor|gait|toe[- ]?walking|tripping/.test(t)) found.add("PT");
  return found.size > 0 ? [...found] : null;
}

function detectLanguage(item: InboxItem): "en" | "es" {
  const t = `${item.subject} ${item.body}`.toLowerCase();
  // Spanish if it requests Spanish or the body is clearly Spanish.
  if (/espa[nñ]ol|spanish|prefiero|necesita|gracias|mensaje de voz|hola, soy/.test(t)) {
    return "es";
  }
  return "en";
}

function detectClinicalQuestion(text: string): boolean {
  const t = text.toLowerCase();
  // A request for clinical opinion/advice, as opposed to an operational ask.
  return (
    /should i (be )?worr|is it normal|is this normal|do you think|what should we do|appreciate (your )?advice|should we wait|is that (normal|concerning)|what does (it|this) mean/.test(
      t,
    )
  );
}

function detectSameDay(text: string): boolean {
  const t = text.toLowerCase();
  return /\btoday\b|this (morning|afternoon)|same[- ]day|right now|hoy/.test(t);
}

function detectIntent(text: string, hasReferralShape: boolean, sameDay: boolean): Intent {
  const t = text.toLowerCase();
  if (/unsubscribe|special offer|promotion|vendor|sales|webinar|free trial|marketing|partnership opportunity/.test(t)) {
    return "spam";
  }
  if (/reschedul|cancel|can'?t make|cannot make|move (my|the|today)/.test(t)) {
    return "scheduling";
  }
  const billingLike = /copay|deductible|bill|invoice|superbill|statement|charge/.test(t);
  const authOrBenefitsLike = /authori[sz]ation|\bauth\b|pre[- ]?auth|coverage|benefits/.test(t);
  if (billingLike || (!hasReferralShape && authOrBenefitsLike)) {
    return "billing_question";
  }
  if (/just (an )?fyi|for your records|no action needed|confirming receipt|we got your fax/.test(t)) {
    return "fyi";
  }
  if (/referr|evaluation|evaluaci|referido|\beval\b|new patient|intake/.test(t) || hasReferralShape) {
    return "new_referral";
  }
  return "other";
}

const HARD_SAFETY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(getting rough|rough with (him|her|them|my)|hits? (him|her|them|the child)|beat|beaten|punch)\b/i, reason: "Possible physical harm by a caregiver" },
  { re: /\babuse|abusing|abused|molest|assault\b/i, reason: "Explicit abuse language" },
  { re: /\bneglect|left alone|not safe|don'?t feel safe|do not feel safe|unsafe at home|afraid of (his|her|their) (dad|mom|father|mother|parent)\b/i, reason: "Neglect or unsafe caregiving concern" },
  { re: /\b(wants? to die|kill (myself|himself|herself)|suicid|self-harm|hurt (myself|himself|herself)|(?:does not|doesn't|do not|don'?t|did not|didn't) want to be (?:here|alive)(?: anymore)?)\b/i, reason: "Possible self-harm / suicidal statement" },
  { re: /\b(hurts? (him|her|them)|threaten|hitting the (child|kid|baby))\b/i, reason: "Threat or harm toward the child" },
];

const SOFT_SAFETY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(hits? other (kids|children)|bites?|tantrum|aggressive|melt ?down|throws? things)\b/i, reason: "Behavioral concern (likely normal therapy content) — flag for reviewer" },
  { re: /\bfell|hurt (his|her|their) (arm|leg|head|knee)|injur/i, reason: "Mention of injury — confirm context" },
];

function detectSafetyCandidates(text: string): SafetyCandidate[] {
  const candidates: SafetyCandidate[] = [];
  for (const { re, reason } of HARD_SAFETY_PATTERNS) {
    if (re.test(text)) candidates.push({ tier: "hard", reason, source: "rule" });
  }
  // Only attach soft signals when nothing hard already fired (hard subsumes).
  if (candidates.length === 0) {
    for (const { re, reason } of SOFT_SAFETY_PATTERNS) {
      if (re.test(text)) candidates.push({ tier: "soft", reason, source: "rule" });
    }
  }
  return candidates;
}

/**
 * Deterministic, general-purpose extraction. Uses no item-specific knowledge —
 * only structural patterns common to fax referrals, voicemails, portal
 * messages, and emails. This is both the no-LLM path and the validation/merge
 * baseline for the LLM path.
 */
export function extractFactsDeterministic(item: InboxItem): Facts {
  const body = item.body || "";
  const text = `${item.subject}\n${body}`;

  const child_name =
    labelValue(body, ["child", "patient", "name"]) ?? detectNameProse(body);

  const dobRaw = labelValue(body, ["dob", "date of birth"]) ?? null;
  const dobMatch = (dobRaw ?? body).match(DOB_RE);
  const dob = dobMatch ? dobMatch[1] : null;

  const ageMatch = text.match(AGE_RE);
  const age = !dob && ageMatch ? `${ageMatch[1]} years old` : null;

  const email = body.match(EMAIL_RE)?.[0] ?? item.sender.match(EMAIL_RE)?.[0] ?? null;
  const phone = body.match(PHONE_RE)?.[0] ?? null;
  const parentName = labelValue(body, ["parent", "guardian", "parent/guardian"]);
  const parent_contact =
    [parentName, phone, email].filter(Boolean).join(", ") || null;

  const discipline = detectDisciplines(text);

  const diagnosis_or_concern =
    labelValue(body, ["concern", "diagnosis", "diagnosis/concern", "reason"]) ?? null;

  const payerRaw = labelValue(body, ["insurance", "payer", "plan"]);
  const payer = payerRaw && !isBlank(payerRaw) ? payerRaw : detectPayerInline(body);
  const member_id = labelValue(body, ["member id", "member", "id", "miembro"]);

  const language = detectLanguage(item);
  const isClinicalQuestion = detectClinicalQuestion(text);
  const sameDay = detectSameDay(text);

  const hasReferralShape = item.channel === "fax_referral" || /referr|evaluation/i.test(text);
  const { intent, missing_info, missingCoreIntake, wantsBooking } = deriveIntakeSignals(
    { child_name, dob, age, parent_contact, payer },
    text,
    hasReferralShape,
    sameDay,
  );

  const safetyCandidates = detectSafetyCandidates(text);

  return {
    child_name,
    dob,
    age,
    parent_contact,
    discipline,
    diagnosis_or_concern,
    payer,
    member_id,
    language,
    intent,
    isClinicalQuestion,
    wantsBooking,
    sameDay,
    missingCoreIntake,
    missing_info,
    hasReferralShape,
    safetyCandidates,
  };
}

const BOOKING_RE = /book|schedul|opening|appointment|get him in|get her in|eval/i;

interface IntakeSignals {
  intent: Intent;
  missing_info: string[];
  missingCoreIntake: boolean;
  wantsBooking: boolean;
}

/**
 * Field-dependent triage signals (intent, missing_info, missing-core-intake,
 * booking intent), derived purely from the extracted field values + text. Kept
 * separate so it can be re-run after LLM enrichment fills gaps — otherwise
 * missing_info / intent would contradict the merged facts.
 */
function deriveIntakeSignals(
  f: {
    child_name: string | null;
    dob: string | null;
    age: string | null;
    parent_contact: string | null;
    payer: string | null;
  },
  text: string,
  hasReferralShape: boolean,
  sameDay: boolean,
): IntakeSignals {
  let intent = detectIntent(text, hasReferralShape, sameDay);

  const missing_info: string[] = [];
  if (!f.child_name) missing_info.push("child name");
  if (!f.dob && !f.age) missing_info.push("date of birth or age");
  if (!f.parent_contact) missing_info.push("parent/guardian contact");
  if (!f.payer && intent === "new_referral") missing_info.push("insurance / payer");

  const coreMissingCount = [!f.dob && !f.age, !f.parent_contact, !f.payer].filter(Boolean).length;
  const missingCoreIntake = hasReferralShape && coreMissingCount >= 2;
  if (missingCoreIntake) intent = "missing_paperwork";

  const wantsBooking = intent === "new_referral" || BOOKING_RE.test(text);

  return { intent, missing_info, missingCoreIntake, wantsBooking };
}

/**
 * Re-derive field-dependent signals after a merge, so a referral whose blank
 * payer/DOB the LLM recovered is no longer mis-routed as missing-paperwork and
 * never lists a now-present field in missing_info.
 */
export function recomputeIntakeSignals(facts: Facts, item: InboxItem): Facts {
  const text = `${item.subject}\n${item.body || ""}`;
  const signals = deriveIntakeSignals(facts, text, facts.hasReferralShape, facts.sameDay);
  return { ...facts, ...signals };
}

/** Detect a payer named inline (no label), e.g. "Insurance is Aetna PPO". */
function detectPayerInline(body: string): string | null {
  const m = body.match(
    /\b(aetna|blue cross|bluecross|bcbs|united\s?health\w*|uhc|medicaid|kaiser|cigna\s?\w*|beacon|sunrise|pediatric choice|community first)[^,.\n]*/i,
  );
  return m ? m[0].trim() : null;
}

/**
 * Merge optional LLM-extracted facts onto the deterministic baseline. The LLM
 * may fill gaps and add safety candidates, but it can never remove a fact or
 * clear a safety signal (asymmetric trust is enforced in safety.ts via union).
 */
export function mergeFacts(base: Facts, llm: Partial<Facts> | null): Facts {
  if (!llm) return base;
  const merged: Facts = { ...base };

  const prefer = <K extends keyof Facts>(key: K) => {
    const v = llm[key];
    if (v !== undefined && v !== null && v !== "") {
      (merged[key] as Facts[K]) = v as Facts[K];
    }
  };

  prefer("child_name");
  prefer("dob");
  prefer("age");
  prefer("parent_contact");
  prefer("diagnosis_or_concern");
  prefer("payer");
  prefer("member_id");

  if (llm.discipline && llm.discipline.length > 0) merged.discipline = llm.discipline;
  if (llm.language) merged.language = llm.language;
  if (typeof llm.isClinicalQuestion === "boolean") {
    merged.isClinicalQuestion = base.isClinicalQuestion || llm.isClinicalQuestion;
  }

  // Safety candidates are a strict union — never lose a deterministic signal.
  if (llm.safetyCandidates && llm.safetyCandidates.length > 0) {
    merged.safetyCandidates = [...base.safetyCandidates, ...llm.safetyCandidates];
  }

  return merged;
}
