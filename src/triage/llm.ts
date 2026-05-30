import type { Discipline, InboxItem } from "../types.js";
import type { DecisionContext, Facts } from "./types.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const TIMEOUT_MS = 20_000;

export function isLLMEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Lazily construct the SDK client so a missing dep/key never breaks the no-LLM run. */
async function getClient(): Promise<{ create: (body: unknown) => Promise<unknown> } | null> {
  try {
    const mod = await import("@anthropic-ai/sdk");
    const Anthropic = (mod as { default: new (opts: { apiKey: string }) => unknown }).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY as string }) as {
      messages: { create: (body: unknown) => Promise<unknown> };
    };
    return client.messages;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("llm_timeout")), TIMEOUT_MS)),
  ]);
}

function extractText(response: unknown): string | null {
  const content = (response as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return null;
  const text = content.find((b) => b.type === "text")?.text;
  return text ?? null;
}

function parseJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  return JSON.parse(raw.slice(start, end + 1));
}

const VALID_DISCIPLINES = new Set<Discipline>(["SLP", "OT", "PT"]);

/**
 * Optional LLM enrichment of extracted facts. Returns ONLY fields the LLM is
 * trusted to fill (free-text extraction + additional safety candidates). The
 * LLM never sets urgency, picks tools, or constructs schema — those are the
 * deterministic core's job. Any failure/garbage returns null so extraction
 * falls back cleanly.
 */
export async function extractFactsLLM(item: InboxItem): Promise<Partial<Facts> | null> {
  const messages = await getClient();
  if (!messages) return null;

  const prompt = `You are a careful intake assistant for a pediatric therapy practice. Extract structured facts from ONE inbox item. Do not give clinical advice. Return ONLY JSON with this exact shape:
{
  "child_name": string|null,
  "dob": "YYYY-MM-DD"|null,
  "age": string|null,
  "parent_contact": string|null,
  "discipline": ("SLP"|"OT"|"PT")[]|null,
  "diagnosis_or_concern": string|null,
  "payer": string|null,
  "member_id": string|null,
  "language": "en"|"es",
  "isClinicalQuestion": boolean,
  "safetyCandidates": [{"tier":"hard"|"soft","reason":string}]
}
Rules:
- "isClinicalQuestion" is true when the sender asks for a clinical opinion/advice rather than an operational action.
- safetyCandidates: include a "hard" candidate for any sign of abuse, neglect, unsafe caregiving, physical harm to the child, or credible self-harm. Use "soft" for ambiguous behavioral mentions. If nothing, return [].
- Be conservative; do not invent data not present.

Inbox item:
channel: ${item.channel}
sender: ${item.sender}
subject: ${item.subject}
body: ${item.body}`;

  try {
    const response = await withTimeout(
      messages.create({
        model: MODEL,
        max_tokens: 700,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const text = extractText(response);
    if (!text) return null;
    const parsed = parseJsonBlock(text) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return sanitizeFacts(parsed);
  } catch {
    return null;
  }
}

function sanitizeFacts(p: Record<string, unknown>): Partial<Facts> {
  const out: Partial<Facts> = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  out.child_name = str(p.child_name);
  out.dob = str(p.dob);
  out.age = str(p.age);
  out.parent_contact = str(p.parent_contact);
  out.diagnosis_or_concern = str(p.diagnosis_or_concern);
  out.payer = str(p.payer);
  out.member_id = str(p.member_id);
  if (p.language === "es" || p.language === "en") out.language = p.language;
  if (typeof p.isClinicalQuestion === "boolean") out.isClinicalQuestion = p.isClinicalQuestion;

  if (Array.isArray(p.discipline)) {
    const ds = p.discipline.filter((d): d is Discipline => VALID_DISCIPLINES.has(d as Discipline));
    out.discipline = ds.length > 0 ? [...new Set(ds)] : null;
  }

  if (Array.isArray(p.safetyCandidates)) {
    out.safetyCandidates = p.safetyCandidates
      .filter((c) => c && (c.tier === "hard" || c.tier === "soft") && typeof c.reason === "string")
      .map((c: { tier: "hard" | "soft"; reason: string }) => ({
        tier: c.tier,
        reason: c.reason,
        source: "llm" as const,
      }));
  }

  return out;
}

/**
 * Optional LLM-generated draft. Produces empathetic, operational prose. The
 * caller ALWAYS runs the result through assertNoClinicalAdvice and falls back
 * to a safe template on violation, so the LLM can never leak advice into output.
 */
export async function generateDraftLLM(
  facts: Facts,
  context: DecisionContext,
  scenario: string,
): Promise<string | null> {
  const messages = await getClient();
  if (!messages) return null;

  const prompt = `Write a short, warm, professional DRAFT reply for front-desk staff to review (never sent automatically) at a pediatric therapy practice. Language: ${facts.language === "es" ? "Spanish" : "English"}.

HARD RULES (compliance):
- NO clinical advice of any kind: no symptom interpretation, no diagnosis, no "sounds like", no home exercises/stretches, no medications, no prognosis or reassurance about a clinical course, no explaining what a behavior means.
- Only operational content: acknowledge receipt, explain the next operational step, and make clear this is a draft for staff review (no appointment is booked, no message has been sent).
- 2-4 sentences. Address the family warmly.

Scenario: ${scenario}
Child: ${facts.child_name ?? "the child"}
Next step context: ${context.rationale.join("; ")}

Return ONLY the draft text, no preamble.`;

  try {
    const response = await withTimeout(
      messages.create({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const text = extractText(response);
    return text ? text.trim() : null;
  } catch {
    return null;
  }
}
