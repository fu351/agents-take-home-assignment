import type { DraftScenario, Facts } from "./types.js";

/**
 * Deterministic guard that rejects any draft containing clinical advice. This
 * is the single most important medical guardrail: front-desk automation must
 * never interpret symptoms, give home exercises, recommend meds, offer
 * prognosis/reassurance, or explain what a behavior means clinically. Drafts
 * may only do operational things (acknowledge, route, request info, explain a
 * scheduling/benefits next step).
 *
 * Pattern checks have recall gaps; production would add an LLM-as-judge pass
 * and a human review queue (which the design already requires).
 */
const CLINICAL_ADVICE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(try|do|practice|recommend)\b[^.]*\b(stretch|exercise|drill|at home|technique)\b/i, reason: "home exercise / therapy instruction" },
  { re: /\bsounds like\b|\bthat (could|might) be\b|\blikely (a|an)\b|\bappears to be (a|an)\b/i, reason: "symptom interpretation / suspected diagnosis" },
  { re: /\b(diagnos|disorder|condition)\b/i, reason: "diagnostic language" },
  { re: /\b(take|give|dose|medication|supplement|vitamin|melatonin|ibuprofen|tylenol)\b/i, reason: "medication / dose recommendation" },
  { re: /\b(it'?ll improve|should improve|nothing to worry about|don'?t worry|it'?s normal|perfectly normal|no cause for concern|will (get|be) (better|fine)|give it (a few weeks|time))\b/i, reason: "prognosis / clinical reassurance" },
  { re: /\bthis (behavior|means|indicates)\b|\bmeans (he|she|they|your child)\b/i, reason: "interpreting what a behavior means" },
  { re: /\byou should (wait|try|start|stop)\b/i, reason: "clinical recommendation" },
];

export function assertNoClinicalAdvice(draft: string): { ok: boolean; reason?: string } {
  for (const { re, reason } of CLINICAL_ADVICE_PATTERNS) {
    if (re.test(draft)) return { ok: false, reason };
  }
  return { ok: true };
}

/**
 * Spanish clinical-advice patterns. The English set above does not fire on
 * Spanish prose, so a Spanish (LLM) draft would otherwise be unscreened — a
 * real hole for our Spanish-speaking families. Tuned NOT to match the vetted
 * Spanish templates (e.g. "podría estar fuera de la red", "Parece que faltan").
 */
const CLINICAL_ADVICE_PATTERNS_ES: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(un|una)\s+(retraso|trastorno|condici[óo]n|diagn[óo]stico|s[íi]ndrome)\b/i, reason: "diagnostic / symptom language (es)" },
  { re: /\bdiagn[óo]stic|\btrastorno\b|\bs[íi]ndrome\b/i, reason: "diagnostic language (es)" },
  { re: /\bes\s+(completamente\s+|perfectamente\s+)?normal\b|no\s+se\s+preocupe[n]?|no\s+hay\s+de\s+qu[ée]\s+preocupar|mejorar[áa]\b|estar[áa]\s+bien|d[ée]le\s+tiempo/i, reason: "prognosis / reassurance (es)" },
  { re: /\bpued[ea]n?\s+esperar\b|deber[íi]a[n]?\s+esperar\b/i, reason: "advice to wait (es)" },
  { re: /\b(tome|tomar|dosis|medicaci[óo]n|medicamento|suplemento|vitamina|melatonina|ibuprofeno)\b/i, reason: "medication / dose (es)" },
  { re: /\bparece\s+(ser|tener|tratarse)\b|\bsuena a\b|\bprobablemente\s+(sea|tenga|es)\b|\bpodr[íi]a\s+(ser|tener|tratarse)\b/i, reason: "symptom interpretation (es)" },
  { re: /\bsignifica que\b|\bindica que\b|\besto quiere decir\b/i, reason: "interpreting behavior (es)" },
  { re: /\bdeber[íi]a[n]?\s+(intentar|empezar|comenzar|dejar|probar|hacer)\b/i, reason: "clinical recommendation (es)" },
];

/**
 * Phrases that would imply the message was actually sent or the appointment
 * finalized. A reviewable hold "pending confirmation" is allowed; a claim that
 * something is booked/confirmed/sent is not.
 */
const IMPLIES_SENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(we'?ve|we have|i'?ve|i have)\s+(sent|emailed|messaged|called|scheduled|booked|confirmed|registered|enrolled)\b/i, reason: "implies an action was already taken / message sent" },
  { re: /\b(your|the)\s+(appointment|evaluation|eval|visit|slot)\s+(is|has been)\s+(booked|scheduled|confirmed|set|reserved)\b/i, reason: "implies the appointment is finalized" },
  { re: /\b(message|reply|email)\s+(has been|was|is)\s+sent\b/i, reason: "implies the message was sent" },
  { re: /\bhemos\s+(enviado|programado|agendado|confirmado|inscrito)\b/i, reason: "implies an action was already taken (es)" },
  { re: /\bsu\s+cita\s+(est[áa]|ha sido)\s+(confirmada|programada|agendada|reservada)\b/i, reason: "implies the appointment is finalized (es)" },
  { re: /\b(mensaje|correo)\s+(enviado|ha sido enviado)\b/i, reason: "implies the message was sent (es)" },
];

/** Internal artifact ids (hold_/task_/draft_/etc.) must never reach a family. */
const INTERNAL_ID_RE = /\b(hold|task|draft|esc|slot|pat|prov)_[A-Za-z0-9]{4,}\b/;

/**
 * Full screen applied to EVERY emitted draft (LLM-generated or template): no
 * clinical advice (EN or ES), no claim that anything was sent/booked, and no
 * leaked internal ids. A failing draft is replaced upstream by a vetted template.
 */
export function screenDraft(draft: string, lang: "en" | "es"): { ok: boolean; reason?: string } {
  const advice = assertNoClinicalAdvice(draft);
  if (!advice.ok) return advice;
  if (lang === "es") {
    for (const { re, reason } of CLINICAL_ADVICE_PATTERNS_ES) {
      if (re.test(draft)) return { ok: false, reason };
    }
  }
  for (const { re, reason } of IMPLIES_SENT_PATTERNS) {
    if (re.test(draft)) return { ok: false, reason };
  }
  if (INTERNAL_ID_RE.test(draft)) return { ok: false, reason: "contains an internal artifact id" };
  return { ok: true };
}

const DISCLAIMER_RE_EN = /draft for staff review|draft only|not (yet )?sent|has not been sent|no appointment (has been|is) booked/i;
const DISCLAIMER_RE_ES = /borrador|revisi[óo]n del personal|no se ha enviado|no enviado|no se ha reservado/i;

/**
 * Guarantee the "draft for staff review / not sent" disclaimer that every safe
 * template carries — appended when an accepted LLM draft omits it.
 */
export function ensureDisclaimer(draft: string, lang: "en" | "es"): string {
  const has = lang === "es" ? DISCLAIMER_RE_ES.test(draft) : DISCLAIMER_RE_EN.test(draft);
  if (has) return draft;
  const note =
    lang === "es"
      ? "\n\n(Borrador para revisión del personal; no se ha enviado y no se ha reservado ninguna cita.)"
      : "\n\n(Draft for staff review; it has not been sent and no appointment has been booked.)";
  return `${draft}${note}`;
}

const ES = (en: string, es: string, lang: "en" | "es") => (lang === "es" ? es : en);

/**
 * Pre-vetted, advice-free templates that ROUTE rather than advise. Used as the
 * deterministic default and as the safe fallback whenever a generated draft
 * fails `assertNoClinicalAdvice`. All read explicitly as drafts for staff
 * review and never imply a message was sent.
 */
export function safeTemplate(scenario: DraftScenario, facts: Facts): string | null {
  const name = firstName(facts.child_name) ?? "your child";
  const lang = facts.language;

  switch (scenario) {
    case "scheduling":
      return ES(
        `Thank you for your referral for ${name}. We have received the information and a team member will reach out to confirm details and finalize an evaluation appointment. This is a draft for staff review and no appointment has been booked yet.`,
        `Gracias por su referido para ${name}. Hemos recibido la información y un miembro de nuestro equipo se comunicará para confirmar los detalles y coordinar una cita de evaluación. Este es un borrador para revisión del personal; aún no se ha reservado ninguna cita.`,
        lang,
      );
    case "oon_benefits":
      return ES(
        `Thank you for reaching out about ${name}. Before we move forward with scheduling, our billing team needs to review your insurance, which may be out of network for Cedar Kids Therapy. A team member will follow up with benefits options. This is a draft for staff review.`,
        `Gracias por comunicarse sobre ${name}. Antes de programar una cita, nuestro equipo de facturación debe revisar su seguro, que podría estar fuera de la red de Cedar Kids Therapy. Un miembro del equipo le contactará con opciones de cobertura. Este es un borrador para revisión del personal.`,
        lang,
      );
    case "clinical_routing":
      return ES(
        `Thank you for your message about ${name}. Questions like this are best answered by one of our clinicians, so we would like to route this to a screening or evaluation rather than answer over message. A team member will follow up about next steps. This is a draft for staff review.`,
        `Gracias por su mensaje sobre ${name}. Preguntas como esta las responde mejor uno de nuestros clínicos, por lo que preferimos coordinar una evaluación en lugar de responder por mensaje. Un miembro del equipo le contactará sobre los próximos pasos. Este es un borrador para revisión del personal.`,
        lang,
      );
    case "intake_missing_info":
      return ES(
        `Thank you for the referral for ${name}. A few details appear to be missing, so a team member will reach out to collect the information we need before scheduling an evaluation. This is a draft for staff review.`,
        `Gracias por el referido para ${name}. Parece que faltan algunos datos, por lo que un miembro del equipo se comunicará para obtener la información necesaria antes de programar una evaluación. Este es un borrador para revisión del personal.`,
        lang,
      );
    case "same_day_reschedule":
      return ES(
        `Thank you for letting us know about ${name}'s appointment today. A team member will follow up promptly to reschedule. This is a draft for staff review.`,
        `Gracias por avisarnos sobre la cita de ${name} de hoy. Un miembro del equipo se comunicará pronto para reprogramarla. Este es un borrador para revisión del personal.`,
        lang,
      );
    case "verify_identity":
      return ES(
        `Thank you for your message regarding ${name}. Before we can schedule anything, a team member needs to confirm a few identifying details to make sure we have the correct record on file. Someone will reach out shortly to verify this with you. This is a draft for staff review; no appointment has been booked.`,
        `Gracias por su mensaje sobre ${name}. Antes de programar una cita, un miembro de nuestro equipo necesita confirmar algunos datos para asegurarse de que tenemos el registro correcto. Alguien se comunicará pronto para verificarlo con usted. Este es un borrador para revisión del personal; no se ha reservado ninguna cita.`,
        lang,
      );
    case "acknowledge":
      return ES(
        `Thank you for your message regarding ${name}. We have received it and a team member will review and follow up as needed. This is a draft for staff review.`,
        `Gracias por su mensaje sobre ${name}. Lo hemos recibido y un miembro del equipo lo revisará y dará seguimiento según sea necesario. Este es un borrador para revisión del personal.`,
        lang,
      );
    case "none":
    default:
      return null;
  }
}

function firstName(full: string | null): string | null {
  if (!full) return null;
  return full.trim().split(/\s+/)[0] || null;
}
