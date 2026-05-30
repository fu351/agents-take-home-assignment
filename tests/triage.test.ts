import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { before, test } from "node:test";
import { createRequire } from "node:module";

import { runAgent } from "../src/agent.js";
import {
  configureTrace,
  getToolCallsForItem,
  search_patient,
  withItemContext,
} from "../src/tools.js";
import type { InboxItem, ItemOutput } from "../src/types.js";
import { assertNoClinicalAdvice } from "../src/triage/draftGuard.js";
import { extractFactsDeterministic } from "../src/triage/extract.js";
import { classify } from "../src/triage/classify.js";
import { assessSafety } from "../src/triage/safety.js";
import { buildOutputItem } from "../src/triage/output.js";
import type {
  ClassificationResult,
  DecisionContext,
  Facts,
  SafetyAssessment,
} from "../src/triage/types.js";

const REPO_ROOT = process.cwd();
const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile: (
    schema: Record<string, unknown>,
  ) => ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> };
};
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv>) => void;

before(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

test("hard safety phrases classify as P0", () => {
  for (const body of [
    "I do not feel safe leaving him with his dad.",
    "He said he does not want to be here anymore.",
  ]) {
    const result = classifyBody(body);
    assert.equal(result.safety.tier, "hard", body);
    assert.equal(result.classification.urgency, "P0", body);
    assert.equal(result.classification.classification, "safeguarding", body);
  }
});

test("ambiguous injury, behavior, urgent, or ASAP language does not become P0", () => {
  for (const body of [
    "He hurt his arm on the playground and we may need to move next week's visit.",
    "He hits other kids sometimes and we would like OT help.",
    "URGENT ASAP: please call me about scheduling an evaluation.",
  ]) {
    const result = classifyBody(body);
    assert.notEqual(result.safety.tier, "hard", body);
    assert.notEqual(result.classification.urgency, "P0", body);
  }
});

test("priority calibration stays P2 by default, raises same-day blockers to P1, and spam to P3", () => {
  const cases: Array<[string, string]> = [
    [
      "Child: Maya Park. DOB: 2018-01-02. Parent: Ana Park, 555-1000. Insurance: Aetna PPO. Concern: speech delay. Please schedule SLP evaluation.",
      "P2",
    ],
    [
      "Can we schedule an OT evaluation next week for my child? Parent: Lee, 555-1001. Insurance: Aetna PPO.",
      "P2",
    ],
    ["What is our copay for Aetna before we schedule next week?", "P2"],
    ["We need to cancel today's OT appointment.", "P1"],
    [
      "The authorization is not approved and he has an appointment today. Please help before the visit.",
      "P1",
    ],
    ["Vendor special offer: free webinar and marketing partnership opportunity.", "P3"],
  ];

  for (const [body, urgency] of cases) {
    assert.equal(classifyBody(body).classification.urgency, urgency, body);
  }
});

test("draft guard rejects clinical advice and allows operational drafts", () => {
  for (const draft of [
    "Try these stretches at home.",
    "That sounds like sensory processing disorder.",
    "He should improve in a few weeks.",
    "Nothing to worry about.",
    "Give him ibuprofen before therapy.",
  ]) {
    assert.equal(assertNoClinicalAdvice(draft).ok, false, draft);
  }

  for (const draft of [
    "Thanks for reaching out. A staff member will review this and follow up with next steps.",
    "We received the referral and need to confirm insurance before scheduling.",
    "We will route this question to the clinical team for review.",
  ]) {
    assert.equal(assertNoClinicalAdvice(draft).ok, true, draft);
  }
});

test("P0 safety item escalates and short-circuits scheduling and insurance tools", async () => {
  const item = makeItem(
    "Child: Ben Hill. DOB: 2018-06-01. Parent: Morgan Hill, 555-1200. Insurance: Aetna PPO. Need SLP evaluation. I do not feel safe leaving him with his dad.",
    { channel: "portal_message" },
  );

  const [output] = await runWithTrace([item]);
  const names = toolNames(output);

  assert.equal(output.urgency, "P0");
  assert.ok(names.includes("escalate"));
  assert.ok(names.includes("create_task"));
  for (const forbidden of ["find_slots", "hold_slot", "verify_insurance"]) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
  assert.equal(output.draft_reply, null);
});

test("in-network payer with clear scheduling request verifies insurance, finds slots, and holds one", async () => {
  const item = makeItem(
    "Child: Nora Quinn. DOB: 2019-05-10. Parent: Max Quinn, 555-1201. Insurance: Aetna PPO. Member ID: AET-1. Concern: fine motor delay. Please schedule an OT evaluation.",
    { channel: "fax_referral" },
  );

  const [output] = await runWithTrace([item]);
  const names = toolNames(output);

  assert.equal(output.urgency, "P2");
  assert.ok(names.includes("verify_insurance"));
  assert.ok(names.includes("find_slots"));
  assert.ok(names.includes("hold_slot"));
});

test("clear scheduling request with unclear discipline does not find or hold a slot", async () => {
  const item = makeItem(
    "Child: Quinn Ray. DOB: 2018-08-08. Parent: Dana Ray, 555-1202. Insurance: Aetna PPO. Please schedule an evaluation.",
    { channel: "fax_referral" },
  );

  const [output] = await runWithTrace([item]);
  const names = toolNames(output);

  assert.ok(names.includes("verify_insurance"));
  assert.equal(names.includes("find_slots"), false);
  assert.equal(names.includes("hold_slot"), false);
});

test("out-of-network, expired, unknown, or missing payer never gets a slot hold", async () => {
  const items = [
    makeItem(
      "Child: Owen Moss. DOB: 2020-02-11. Parent: Rae Moss, 555-1301. Insurance: Kaiser HMO. Concern: fine motor delay. Please schedule OT evaluation.",
      { channel: "fax_referral" },
    ),
    makeItem(
      "Child: Sara Stone. DOB: 2017-03-03. Parent: Jules Stone, 555-1302. Insurance: Sunrise Health. Concern: articulation delay. Please schedule SLP evaluation.",
      { channel: "fax_referral" },
    ),
    makeItem(
      "Child: Milo North. DOB: 2019-04-04. Parent: Pat North, 555-1303. Insurance: Mystery Plan. Concern: toe walking. Please schedule PT evaluation.",
      { channel: "fax_referral" },
    ),
    makeItem(
      "Child: Leah West. Age: 6 years old. Parent: Casey West, 555-1304. Concern: articulation delay. Please schedule SLP evaluation.",
      { channel: "fax_referral" },
    ),
  ];

  const outputs = await runWithTrace(items);
  for (const output of outputs) {
    assert.equal(toolNames(output).includes("hold_slot"), false, output.item_id);
  }
});

test("clinical advice question routes to clinician review and keeps the draft operational", async () => {
  const item = makeItem(
    "My child is 4 years old and toe-walking. Should I be worried, and what should we do at home?",
    { channel: "portal_message", sender: "Parent Portal" },
  );

  const [output] = await runWithTrace([item]);
  const names = toolNames(output);

  assert.equal(output.classification, "clinical_question");
  assert.ok(names.includes("lookup_policy"));
  assert.ok(names.includes("create_task"));
  assert.equal(names.includes("find_slots"), false);
  assert.equal(names.includes("hold_slot"), false);
  assert.equal(assertNoClinicalAdvice(output.draft_reply ?? "").ok, true);
  assert.match(output.recommended_next_action, /clinician|evaluation/i);
});

test("output builder preserves item id, human review, and tool calls unchanged", async () => {
  const item = makeItem("Parent asks for a general follow-up.", { id: "builder_case" });
  configureTrace({ path: tempTracePath("builder") });
  await withItemContext(item.id, async () => {
    await search_patient({ name: "Builder Case" });
  });

  const facts = baseFacts();
  const safety: SafetyAssessment = { tier: "none", reasons: [], source: [] };
  const classification: ClassificationResult = { classification: "other", urgency: "P2" };
  const ctx = baseContext();
  const expectedCalls = getToolCallsForItem(item.id);

  const output = buildOutputItem(item, facts, safety, classification, ctx);

  assert.equal(output.item_id, item.id);
  assert.equal(output.requires_human_review, true);
  assert.deepEqual(output.tools_called, expectedCalls);
});

test("fallback output from a fresh no-trace process is schema-shaped and human-reviewable", () => {
  const script = `
    import { runAgent } from "./src/agent.ts";
    import { buildBatchOutput } from "./src/tools.ts";
    const item = {
      id: "fallback_case",
      channel: "email",
      received_at: "2026-04-27T16:00:00-07:00",
      sender: "parent@example.com",
      subject: "Need help",
      body: "Please review this intake message.",
      attachments: []
    };
    const batch = buildBatchOutput(await runAgent([item]));
    console.log(JSON.stringify(batch));
  `;

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: REPO_ROOT, encoding: "utf8", env: noKeyEnv() },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);

  const batch = JSON.parse(child.stdout) as unknown;
  assertSchemaValid(batch);
  const item = (batch as { items: ItemOutput[] }).items[0];
  assert.equal(item.item_id, "fallback_case");
  assert.equal(item.requires_human_review, true);
  assert.deepEqual(item.tools_called, []);
  assert.match(item.decision_rationale, /Automated triage threw an error/);
});

test("no-key full inbox integration emits one output per input, uses relevant tools, and validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "origin-triage-"));
  const outputPath = join(dir, "output.json");
  const tracePath = join(dir, "tool-calls.jsonl");

  const triage = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/index.ts",
      "--input",
      "data/inbox.json",
      "--output",
      outputPath,
      "--trace",
      tracePath,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: noKeyEnv() },
  );
  assert.equal(triage.status, 0, triage.stderr || triage.stdout);

  const input = JSON.parse(readFileSync(join(REPO_ROOT, "data/inbox.json"), "utf8")) as InboxItem[];
  const output = JSON.parse(readFileSync(outputPath, "utf8")) as { items: ItemOutput[] };
  assert.equal(output.items.length, input.length);
  assert.deepEqual(
    output.items.map((item) => item.item_id).sort(),
    input.map((item) => item.id).sort(),
  );
  assert.ok(output.items.every((item) => item.requires_human_review));
  assert.ok(new Set(output.items.flatMap((item) => item.tools_called.map((call) => call.name))).size >= 3);

  const validate = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/validate.ts",
      "--input",
      "data/inbox.json",
      "--output",
      outputPath,
      "--trace",
      tracePath,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: noKeyEnv() },
  );
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
});

function classifyBody(
  body: string,
): { facts: Facts; safety: SafetyAssessment; classification: ClassificationResult } {
  const facts = extractFactsDeterministic(makeItem(body));
  const safety = assessSafety(facts);
  return { facts, safety, classification: classify(facts, safety) };
}

async function runWithTrace(items: InboxItem[]): Promise<ItemOutput[]> {
  configureTrace({ path: tempTracePath("agent") });
  return runAgent(items);
}

function makeItem(body: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const id = overrides.id ?? `test_${Math.random().toString(36).slice(2)}`;
  const base: InboxItem = {
    ...overrides,
    id,
    channel: "email",
    received_at: "2026-04-27T16:00:00-07:00",
    sender: "Test Parent <parent@example.com>",
    subject: "Test message",
    body,
    attachments: [],
  };
  return { ...base, ...overrides, id };
}

function toolNames(output: ItemOutput): string[] {
  return output.tools_called.map((call) => call.name);
}

function tempTracePath(label: string): string {
  return join(tmpdir(), `origin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function noKeyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

function assertSchemaValid(batch: unknown): void {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema/output.schema.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(batch), true, JSON.stringify(validate.errors, null, 2));
}

function baseFacts(): Facts {
  return {
    child_name: null,
    dob: null,
    age: null,
    parent_contact: null,
    discipline: null,
    diagnosis_or_concern: null,
    payer: null,
    member_id: null,
    language: "en",
    intent: "other",
    isClinicalQuestion: false,
    wantsBooking: false,
    sameDay: false,
    missingCoreIntake: false,
    missing_info: [],
    hasReferralShape: false,
    safetyCandidates: [],
  };
}

function baseContext(): DecisionContext {
  return {
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
    rationale: ["test rationale"],
    draftRecipient: null,
    draftChannel: null,
  };
}
