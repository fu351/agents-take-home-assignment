import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "../tools.js";
import type { Assignee, InboxItem } from "../types.js";
import { generateDraftLLM, isLLMEnabled } from "./llm.js";
import { assertNoClinicalAdvice, safeTemplate } from "./draftGuard.js";
import type {
  ClassificationResult,
  DecisionContext,
  DraftScenario,
  Facts,
  InsuranceResult,
} from "./types.js";

const OON_STATUSES = new Set(["out_of_network", "expired", "unknown"]);

/**
 * The conditional, data-dependent orchestration tree. Tool results gate the
 * next step; nothing is performative. MUST be called inside withItemContext so
 * tool calls are attributed to this item in the audit trace.
 */
export async function orchestrateTools(
  item: InboxItem,
  facts: Facts,
  classification: ClassificationResult,
): Promise<DecisionContext> {
  const ctx: DecisionContext = {
    patientFound: false,
    patientId: null,
    insurance: null,
    insuranceDiscrepancy: null,
    slotsFound: 0,
    heldSlot: null,
    task_ids: [],
    escalation: null,
    draftScenario: "none",
    draftBody: null,
    rationale: [],
    draftRecipient: contactFor(item, facts),
    draftChannel: channelFor(item),
  };

  // ---- P0 safeguarding: escalate and get out of the way. No parent draft. ----
  if (classification.urgency === "P0") {
    const esc = await escalate({
      item_id: item.id,
      reason: `Suspected safeguarding concern: ${facts.safetyCandidates.map((c) => c.reason).join("; ")}`,
      severity: "P0",
    });
    ctx.escalation = { reason: String(esc.args.reason), severity: "P0" };

    const task = await create_task({
      assignee: "clinical_lead",
      title: `Same-hour safeguarding review: ${facts.child_name ?? item.subject}`,
      due: sameHourDue(item),
      notes:
        "Possible safeguarding disclosure. Do NOT contact the family with reassurance. Escalate per safeguarding policy and follow mandated-reporter steps.",
    });
    ctx.task_ids.push(task.data.task_id);
    ctx.draftScenario = "none"; // explicitly no draft
    ctx.rationale.push(
      "Hard safety signal → P0; escalated to clinical lead and created a same-hour review task; deliberately produced no parent draft and ran no scheduling/billing steps.",
    );
    return ctx;
  }

  // ---- Cheap exit for noise. ----
  if (facts.intent === "spam" || facts.intent === "fyi") {
    ctx.rationale.push(
      `Classified as ${facts.intent}; no tools warranted beyond human confirmation (avoided performative calls).`,
    );
    return ctx;
  }

  // ---- Identity grounding first. ----
  const patient = await search_patient({
    name: facts.child_name ?? undefined,
    dob: facts.dob ?? undefined,
  });
  if (patient.data.length > 0) {
    ctx.patientFound = true;
    ctx.patientId = patient.data[0].patient_id;
    ctx.rationale.push(`search_patient → existing patient ${patient.data[0].name}.`);
  } else {
    ctx.rationale.push("search_patient → no existing record (treat as new/unverified).");
  }

  // ---- Clinical advice question: route, never answer. ----
  if (facts.isClinicalQuestion) {
    await lookup_policy({ topic: "clinical_advice" });
    const task = await create_task({
      assignee: "clinical_lead",
      title: `Clinician review of parent question re ${facts.child_name ?? "child"}`,
      due: nextBusinessDue(item, 1),
      notes: `Parent asked a clinical question; route to screening/evaluation. Do not answer clinically over message. Concern: ${facts.diagnosis_or_concern ?? facts.child_name ?? "n/a"}.`,
    });
    ctx.task_ids.push(task.data.task_id);
    ctx.draftScenario = "clinical_routing";
    ctx.rationale.push(
      "Clinical question detected → cited clinical_advice policy, created a clinician-review task, and drafted a routing reply (no clinical advice given).",
    );
    await finalizeDraft(item, facts, ctx);
    return ctx;
  }

  // ---- Incomplete referral: collect missing info before anything else. ----
  if (facts.missingCoreIntake) {
    await lookup_policy({ topic: "service_lines" });
    const task = await create_task({
      assignee: "intake",
      title: `Obtain missing intake info for ${facts.child_name ?? item.subject}`,
      due: nextBusinessDue(item, 1),
      notes: `Referral is missing: ${facts.missing_info.join(", ")}. Collect before scheduling an evaluation.`,
    });
    ctx.task_ids.push(task.data.task_id);
    // Only draft if we actually have somewhere to send it.
    ctx.draftScenario = ctx.draftRecipient ? "intake_missing_info" : "none";
    ctx.rationale.push(
      `Referral missing core fields (${facts.missing_info.join(", ")}) → created intake task to obtain them; no slot held until intake is complete.`,
    );
    await finalizeDraft(item, facts, ctx);
    return ctx;
  }

  // ---- Same-day reschedule/cancel: P1 operational, no hold. ----
  if (classification.urgency === "P1") {
    await lookup_policy({ topic: "scheduling" });
    const task = await create_task({
      assignee: "front_desk",
      title: `Same-day reschedule for ${facts.child_name ?? item.subject}`,
      due: sameHourDue(item),
      notes: "Same-day reschedule/cancel requested. Confirm and offer the next available slot; staff to action today.",
    });
    ctx.task_ids.push(task.data.task_id);
    ctx.draftScenario = "same_day_reschedule";
    ctx.rationale.push(
      "Same-day operational request → P1; cited scheduling policy and created a same-day front-desk task; no automated hold (reschedules are staff-actioned).",
    );
    await finalizeDraft(item, facts, ctx);
    return ctx;
  }

  // ---- Insurance gating for referral / booking requests. ----
  if (facts.payer) {
    const ins = await verify_insurance({
      payer: facts.payer,
      member_id: facts.member_id ?? undefined,
    });
    ctx.insurance = ins.data as InsuranceResult;
    reconcileInsurance(ctx, facts);

    if (OON_STATUSES.has(ctx.insurance.status)) {
      await lookup_policy({ topic: "insurance" });
      const assignee: Assignee = "billing";
      const task = await create_task({
        assignee,
        title: `Benefits conversation for ${facts.child_name ?? item.subject}`,
        due: nextBusinessDue(item, 2),
        notes: `verify_insurance returned ${ctx.insurance.status} for ${facts.payer}. Hold all scheduling until a benefits conversation happens.${ctx.insuranceDiscrepancy ? ` ${ctx.insuranceDiscrepancy}` : ""}`,
      });
      ctx.task_ids.push(task.data.task_id);
      ctx.draftScenario = "oon_benefits";
      ctx.rationale.push(
        `verify_insurance → ${ctx.insurance.status}, so NO slot held; cited insurance policy, created a billing benefits task, and drafted a benefits-conversation reply.`,
      );
      await finalizeDraft(item, facts, ctx);
      return ctx;
    }

    // In-network: proceed to scheduling support if discipline + booking intent are clear.
    ctx.rationale.push(`verify_insurance → ${ctx.insurance.status}.`);
    if (facts.discipline && facts.discipline.length === 1 && facts.wantsBooking) {
      const slots = await find_slots({
        discipline: facts.discipline[0],
        language: facts.language,
      });
      ctx.slotsFound = slots.data.length;
      if (slots.data.length > 0) {
        const slot = slots.data[0];
        const held = await hold_slot({
          slot_id: slot.slot_id,
          patient_ref: ctx.patientId ?? `new:${facts.child_name ?? item.id}`,
        });
        ctx.heldSlot = { provider_name: slot.provider_name, start: slot.start };
        ctx.rationale.push(
          `find_slots(${facts.discipline[0]}, ${facts.language}) → ${slots.data.length} options; placed a reviewable hold (${held.data.hold_id}) on the earliest with ${slot.provider_name}.`,
        );
      } else {
        ctx.rationale.push(`find_slots(${facts.discipline[0]}) → 0 matches; no hold, will offer waitlist on review.`);
      }
    } else {
      ctx.rationale.push("Discipline ambiguous or not a booking request → did not call find_slots (avoids a wrong-discipline hold).");
    }

    const task = await create_task({
      assignee: "intake",
      title: `Confirm and schedule evaluation for ${facts.child_name ?? item.subject}`,
      due: nextBusinessDue(item, 2),
      notes: ctx.heldSlot
        ? `Reviewable hold placed with ${ctx.heldSlot.provider_name} at ${ctx.heldSlot.start}. Confirm with family and finalize.`
        : "Confirm details with family and schedule an evaluation on review.",
    });
    ctx.task_ids.push(task.data.task_id);
    ctx.draftScenario = "scheduling";
    await finalizeDraft(item, facts, ctx);
    return ctx;
  }

  // ---- Fallback: acknowledge + task. ----
  const task = await create_task({
    assignee: "front_desk",
    title: `Review inbox item for ${facts.child_name ?? item.subject}`,
    due: nextBusinessDue(item, 1),
    notes: "Could not fully classify automatically; needs human review.",
  });
  ctx.task_ids.push(task.data.task_id);
  ctx.draftScenario = ctx.draftRecipient ? "acknowledge" : "none";
  ctx.rationale.push("No payer/booking signal; created a general review task and an acknowledgement draft.");
  await finalizeDraft(item, facts, ctx);
  return ctx;
}

/**
 * Verified billing status supersedes the payer claimed on the referral. When
 * they disagree, we flag the discrepancy for the reviewer and never silently
 * trust the unverified claim.
 */
function reconcileInsurance(ctx: DecisionContext, facts: Facts): void {
  if (!ctx.insurance) return;
  const claimed = (facts.payer ?? "").toLowerCase();
  const verifiedPlan = (ctx.insurance.plan ?? "").toLowerCase();

  // A real discrepancy is when the billing system contradicts the referral:
  // coverage shows expired (referral likely stale), or the verified plan name
  // doesn't match the claimed payer. Out-of-network for the *same* payer is not
  // a discrepancy — it's just out of network.
  const planMismatch =
    verifiedPlan.length > 0 && claimed.length > 0 && !verifiedPlan.includes(claimed.split(" ")[0]);
  const statusContradictsClaim = ctx.insurance.status === "expired" || planMismatch;

  if (statusContradictsClaim) {
    ctx.insuranceDiscrepancy = `Referral lists "${facts.payer}"; verification shows ${ctx.insurance.status}${ctx.insurance.plan ? ` (${ctx.insurance.plan})` : ""}. Verified status governs; confirm before billing.`;
    ctx.rationale.push(`Insurance discrepancy surfaced: ${ctx.insuranceDiscrepancy}`);
  }
}

/** Render the chosen draft: LLM (guarded) when enabled, else a safe template. */
async function finalizeDraft(item: InboxItem, facts: Facts, ctx: DecisionContext): Promise<void> {
  if (ctx.draftScenario === "none" || !ctx.draftRecipient || !ctx.draftChannel) {
    ctx.draftScenario = "none";
    return;
  }

  let body: string | null = null;

  if (isLLMEnabled()) {
    const generated = await generateDraftLLM(facts, ctx, ctx.draftScenario);
    if (generated && assertNoClinicalAdvice(generated).ok) {
      body = generated;
    }
  }

  if (!body) {
    body = safeTemplate(ctx.draftScenario, facts);
  }

  if (!body || !assertNoClinicalAdvice(body).ok) {
    // Last-resort safe default; should not happen since templates are vetted.
    body = safeTemplate("acknowledge", facts);
  }

  if (!body) {
    ctx.draftScenario = "none";
    return;
  }

  await draft_message({
    recipient: ctx.draftRecipient,
    channel: ctx.draftChannel,
    body,
    language: facts.language,
  });
  ctx.draftBody = body;
}

function contactFor(item: InboxItem, facts: Facts): string | null {
  if (facts.parent_contact) {
    const email = facts.parent_contact.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
    const phone = facts.parent_contact.match(/\d{3}[-.\s]?\d{4}/)?.[0];
    if (email || phone) return email ?? (phone as string);
  }
  const senderEmail = item.sender.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (senderEmail) return senderEmail;
  // Portal and voicemail items have an implicit reply path back to the sender.
  if (item.channel === "portal_message" || item.channel === "voicemail_transcript") {
    return cleanSender(item.sender);
  }
  return null;
}

/** Strip channel suffixes like "via parent portal" / "voicemail" from a sender label. */
function cleanSender(sender: string): string {
  return sender
    .replace(/\s+via .*/i, "")
    .replace(/\s+(voicemail|fax|email).*/i, "")
    .trim();
}

function channelFor(item: InboxItem): "portal" | "email" | "phone" {
  switch (item.channel) {
    case "portal_message":
      return "portal";
    case "voicemail_transcript":
      return "phone";
    default:
      return "email";
  }
}

function sameHourDue(item: InboxItem): string {
  const base = new Date(item.received_at);
  return new Date(base.getTime() + 60 * 60 * 1000).toISOString();
}

function nextBusinessDue(item: InboxItem, days: number): string {
  const base = new Date(item.received_at);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
