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
