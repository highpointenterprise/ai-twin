import { test } from "node:test";
import assert from "node:assert/strict";
import { CallHandling, classifyAnswer } from "../server/calls/detection";
import { BeepDetector } from "../server/calls/beep";
import { encodeMulaw, dtmfAudio } from "../server/speech/audio";
import { agent, harness, tick, until } from "./helpers";
import { toolSchema } from "../lib/config";

const configured = () => agent({
  voicemailDetection: { enabled: true, action: "leave-message", message: "Please call Acme back.", beepWaitSeconds: 3 },
  callScreening: { enabled: true, response: "Alex from Acme about your appointment." },
  callHandling: { menuSilenceMs: 200, ivrWaitSeconds: 5 },
});
const trace = { log: () => {} };
const tone = (hz: number, ms: number) => Buffer.from(Array.from({ length: ms * 8 }, (_, i) => encodeMulaw(Math.round(7000 * Math.sin(2 * Math.PI * hz * i / 8000)))));
const beepAudio = () => Buffer.concat([tone(1000, 300), Buffer.alloc(800, 255)]);

test("answer evidence distinguishes human, mailbox, screening and single-option IVR", () => {
  for (const [text, kind] of [
    ["Hello?", "human"], ["Who is calling?", "human"], ["This is Sam speaking", "human"],
    ["I heard your voicemail. Can you explain?", "human"], ["Can you leave me a message later?", "human"],
    ["I'm unavailable. Please leave a message after the beep.", "voicemail"],
    ["Your call has been forwarded to voicemail.", "voicemail"],
    ["Please state your name and why you're calling.", "screening"],
    ["If you tell me your name and reason for calling I will see if this person is available.", "screening"],
    ["Please say your name after the tone.", "screening"],
    ["Press 1 to leave a message", "ivr"], ["For support press two", "ivr"],
    ["Thank you for calling Acme", "unknown"],
  ] as const) assert.equal(classifyAnswer(text).kind, kind, text);
});

test("voicemail requires transcript evidence before a beep can trigger a message", () => {
  const h = new CallHandling(configured(), trace, true, true, 0);
  assert.equal(h.beep(100).action, "none");
  assert.equal(h.state, "unknown");
  assert.equal(h.observe("Please leave a message after the beep", false, 2000).action, "wait");
  assert.equal(h.state, "voicemail");
  assert.equal(h.beep(2500).action, "leave-message");
  assert.equal(h.beep(2600).action, "none");
  assert.equal(h.observe("Hello? This is Sam speaking", true, 2700).action, "conversation");
  assert.equal(h.state, "human");
});

test("beep detector rejects DTMF, short tones, ringback and silence", () => {
  assert.equal(new BeepDetector().push(beepAudio()), true);
  assert.equal(new BeepDetector().push(Buffer.alloc(8000, 255)), false);
  assert.equal(new BeepDetector().push(Buffer.concat([tone(1000, 40), Buffer.alloc(800, 255)])), false);
  assert.equal(new BeepDetector().push(dtmfAudio("123#", 200, 100)), false);
  const ring = Buffer.from(Array.from({ length: 16000 }, (_, i) => encodeMulaw(Math.round(4000 * (Math.sin(2 * Math.PI * 440 * i / 8000) + Math.sin(2 * Math.PI * 480 * i / 8000))))));
  assert.equal(new BeepDetector().push(Buffer.concat([ring, Buffer.alloc(4000, 255)])), false);
  const detector = new BeepDetector();
  const audio = beepAudio();
  let found = false;
  for (let i = 0; i < audio.length; i += 73) found = detector.push(audio.subarray(i, i + 73)) || found;
  assert.equal(found, true);
});

test("screening responds only after final transcript, holds, then yields to a human", () => {
  const h = new CallHandling(configured(), trace, true, true, 0);
  assert.equal(h.observe("Please state your name and reason for calling", false, 10).action, "wait");
  assert.equal(h.observe("Please state your name and reason for calling", true, 100).action, "screen");
  assert.equal(h.observe("Please hold while I connect you", true, 200).action, "wait");
  assert.equal(h.observe("Hello, how can I help?", true, 250).action, "conversation");
  assert.equal(h.screeningEncountered, true);
});

test("multi-menu navigation waits for final and quiet audio, bounds retries and transitions to voicemail", () => {
  const h = new CallHandling(configured(), trace, true, true, 0);
  h.speechStart(0);
  h.observe("Press 1 for sales", false, 100);
  assert.equal(h.tick(500).action, "none");
  assert.match(h.beginDtmf(600)!, /complete/);
  h.observe("Press 1 for sales, press 2 for support", true, 700);
  h.audio(true, 800);
  assert.equal(h.tick(999).action, "none");
  assert.equal(h.tick(1000).action, "menu");
  assert.equal(h.beginDtmf(1000), undefined);
  assert.match(h.beginDtmf(1100)!, /complete/);
  h.observe("Press 3 for appointments", true, 1200);
  assert.equal(h.tick(1400).action, "menu");
  assert.equal(h.beginDtmf(1400), undefined);
  h.observe("Please leave a message after the tone", true, 1600);
  assert.equal(h.state, "voicemail");
  assert.equal(h.tick(4600).reason, "voicemail-beep-timeout");
});

test("confidence settings and uncertain fallback cannot report unknown as voicemail", () => {
  const a = configured();
  a.voicemailDetection.confidenceThreshold = 0.99;
  const h = new CallHandling(a, trace, true, true, 0);
  assert.notEqual(h.observe("Please leave a message after the beep", true, 100).action, "hangup");
  const u = new CallHandling(agent({ voicemailDetection: { enabled: true, unknownAction: "hangup", detectionTimeoutSeconds: 3 } }), trace, true, false, 0);
  assert.equal(u.observe("Thank you for calling our office", true, 100).action, "wait");
  assert.equal(u.tick(3000).reason, "answer-detection-ended");
});

test("session detects voicemail from partials, waits for beep and playback acknowledgement", async (t) => {
  const h = harness({ direction: "outbound", agent: configured() });
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await tick();
  h.events.onPartial("Please leave a message after the beep");
  await tick();
  assert.equal(h.spoken.length, 0);
  h.session.pushAudio(beepAudio().toString("base64"));
  await until(() => h.sent.some((m: any) => m.event === "mark"));
  assert.deepEqual(h.spoken, ["Please call Acme back."]);
  assert.equal(h.ended.length, 0);
  const mark = h.sent.find((m: any) => m.event === "mark") as any;
  h.session.handleMark(mark.mark.name);
  await until(() => h.ended.includes("voicemail"));
});

test("session rejects hallucinated DTMF during human conversation", async (t) => {
  let executed = 0;
  const tool = { ...toolSchema.parse({ type: "dtmf", name: "keypad", description: "Navigate menus" }), id: "dtmf" };
  const h = harness({ direction: "outbound", agent: configured(), tools: [tool] }, {
    model: { async *stream() { yield { type: "tool-call", call: { id: "keys", name: "keypad", arguments: '{"keys":"1"}' } }; }, complete: async () => "" },
    executeTool: async () => { executed++; return { result: {}, waitForUser: true }; },
  });
  t.after(() => h.session.close());
  await tick();
  h.events.onEnd("Hello, this is Sam speaking");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(executed, 0);
});

test("human pickup interrupts voicemail even with a one-word hello", async (t) => {
  const h = harness({ direction: "outbound", agent: configured() });
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await tick();
  h.events.onEnd("Please leave a message after the beep");
  h.session.pushAudio(beepAudio().toString("base64"));
  await until(() => h.sent.some((m: any) => m.event === "mark"));
  const mark = (h.sent.find((m: any) => m.event === "mark") as any).mark.name;
  h.events.onEnd("Hello?");
  h.session.handleMark(mark);
  await until(() => h.spoken.length === 2);
  assert.equal(h.ended.length, 0);
  assert.ok(h.sent.some((m: any) => m.event === "clear"));
});

test("fragmented menus preserve earlier options until a quiet final turn", () => {
  const h = new CallHandling(configured(), trace, true, true, 0);
  h.observe("Press one for sales", true, 100);
  h.speechStart(150);
  assert.equal(h.tick(600).action, "none");
  h.observe("press two for support", true, 700);
  const menu = h.tick(900);
  assert.equal(menu.action, "menu");
  assert.match(menu.text!, /one for sales.*two for support/);
});

test("repeated menus and missing DTMF tools terminate without arbitrary selections", () => {
  const h = new CallHandling(configured(), trace, true, true, 0);
  for (let i = 0; i < 2; i++) {
    h.observe("Press 1 for sales", true, i * 1000);
    h.tick(i * 1000 + 200);
    assert.equal(h.beginDtmf(i * 1000 + 200), undefined);
  }
  h.observe("Press 1 for sales", true, 3000);
  h.tick(3200);
  assert.match(h.beginDtmf(3200)!, /limit/);
  const noTool = new CallHandling(configured(), trace, true, false, 0);
  noTool.observe("Press one for sales", true, 100);
  assert.equal(noTool.tick(400).action, "none");
  assert.equal(noTool.tick(5200).reason, "ivr-timeout");
});

test("late greeting transcripts cannot interrupt a voicemail message already playing", async (t) => {
  const h = harness({ direction: "outbound", agent: configured() });
  t.after(() => h.session.close());
  h.setAutoMark(false);
  await tick();
  h.events.onPartial("Please leave a message after the beep");
  h.session.pushAudio(beepAudio().toString("base64"));
  await until(() => h.sent.some((m: any) => m.event === "mark"));
  h.events.onPartial("Please leave a message after the beep");
  h.events.onEnd("Please leave a message after the beep");
  h.events.onEnd("Thank you for calling");
  assert.equal(h.sent.some((m: any) => m.event === "clear"), false);
  h.session.handleMark((h.sent.find((m: any) => m.event === "mark") as any).mark.name);
  await until(() => h.ended.includes("voicemail"));
});
