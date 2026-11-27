import { test } from "node:test";
import assert from "node:assert/strict";
import { CallHandling, classifyAnswer } from "../server/calls/detection";
import { CallTrace } from "../server/observability/trace";
import { agent, harness } from "./helpers";
import { ringAudio } from "./ringback-fixture";
import { callHandlingSchema, toolSchema } from "../lib/config";

const configured = () =>
  agent({
    voicemailDetection: {
      enabled: true,
      action: "leave-message",
      message: "Please call back.",
    },
  });
const observation = { profile: "north-america", toneMs: 2000, silenceMs: 4000 };

test("the reported 6 → 3 → transfer → voicemail sequence does not end at the old IVR deadline", () => {
  const trace = new CallTrace("CA-reported");
  const h = new CallHandling(configured(), trace, true, true, 0);
  h.observe("For other departments dial six", true, 28711);
  h.tick(29502);
  assert.equal(h.beginDtmf(31747), undefined);
  h.dtmfCompleted(32062);
  h.observe("For sales dial three", true, 60871);
  h.tick(61582);
  assert.equal(h.beginDtmf(62586), undefined);
  h.dtmfCompleted(62882);
  assert.equal(
    h.observe("Your call is being transferred.", true, 69833).action,
    "wait",
  );
  assert.equal(h.state, "transfer-wait");
  h.ringback(observation, 76000);
  h.speechStart(91910);
  h.observe("Please leave a message", false, 92390);
  h.audio(true, 92811);
  assert.equal(h.tick(92904).action, "none");
  assert.equal(
    h.observe("Please leave a message after the tone.", true, 93500).action,
    "wait",
  );
  assert.equal(h.state, "voicemail");
  assert.equal(h.beep(94000).action, "leave-message");
  assert.ok(
    !trace.view().events.some((event) => event.event === "call.handling_ended"),
  );
});

test("an incoming greeting protects the IVR deadline even without a transfer announcement", () => {
  const trace = new CallTrace("CA-grace");
  const h = new CallHandling(configured(), trace, true, true, 0);
  h.observe("Press three for sales", true, 0);
  h.beginDtmf(1000);
  h.dtmfCompleted(1200);
  h.speechStart(31000);
  h.observe("Please leave a message", false, 31100);
  assert.equal(h.tick(31200).action, "none");
  assert.equal(h.tick(31300).action, "none");
  assert.equal(
    trace
      .view()
      .events.filter((event) => event.event === "call.timeout_deferred").length,
    1,
  );
  h.observe("Please leave your message after the beep", true, 32000);
  assert.equal(h.beep(33000).action, "leave-message");
});

test("repeated ringing, transfer announcements and stuck speech cannot extend the wait indefinitely", () => {
  const h = new CallHandling(
    configured(),
    new CallTrace("CA-bounded"),
    true,
    true,
    0,
  );
  h.observe("Your call is being transferred", true, 1000);
  for (let now = 5000; now < 120000; now += 6000) {
    h.ringback(observation, now);
    h.observe("Please hold", true, now + 100);
    assert.equal(h.tick(now + 200).action, "none");
  }
  h.speechStart(120900);
  assert.equal(h.tick(121000).action, "none");
  h.audio(true, 151000);
  assert.equal(h.tick(151000).reason, "transfer-wait-timeout");
});

test("ringback alone starts a bounded wait and human pickup or a new menu takes priority", () => {
  const h = new CallHandling(
    configured(),
    new CallTrace("CA-ringing"),
    true,
    true,
    0,
  );
  assert.equal(h.ringback(observation, 1000).action, "wait");
  assert.equal(h.state, "ringing");
  assert.equal(h.tick(11000).action, "none");
  assert.equal(h.state, "transfer-wait");
  assert.equal(
    h.observe("Hello, this is Sam speaking", true, 12000).action,
    "conversation",
  );
  assert.equal(h.tick(122000).action, "none");
  h.observe("I'm transferring you to sales", true, 123000);
  h.observe("Press one for sales", true, 124000);
  assert.equal(h.state, "ivr");
  assert.equal(h.tick(125000).action, "menu");
  assert.equal(h.beginDtmf(125000), undefined);
});

test("ringback cannot override active keypad delivery, voicemail policy, screening, or a closed session", () => {
  const h = new CallHandling(
    configured(),
    new CallTrace("CA-priority"),
    true,
    true,
    0,
  );
  h.observe("Press one for sales", true, 0);
  h.beginDtmf(1000);
  assert.equal(h.ringback(observation, 2000).action, "none");
  h.dtmfCompleted(3000);
  h.observe("Please leave a message after the beep", false, 4000);
  assert.equal(h.ringback(observation, 5000).action, "none");
  h.close();
  assert.equal(h.ringback(observation, 6000).action, "none");
  const stop = new CallHandling(
    agent({ voicemailDetection: { enabled: true, action: "hangup" } }),
    new CallTrace("CA-stop"),
    true,
    false,
    0,
  );
  stop.ringback(observation, 0);
  assert.equal(
    stop.observe("Please leave a message after the beep", true, 1000).reason,
    "voicemail",
  );
  const screening = new CallHandling(
    agent({ callScreening: { enabled: true, response: "Sam from support" } }),
    new CallTrace("CA-screen"),
    true,
    false,
    0,
  );
  screening.observe("Please say your name after the tone", true, 1000);
  assert.equal(screening.ringback(observation, 2000).action, "none");
});

test("transfer announcements do not misclassify a voicemail destination or caller questions", () => {
  assert.equal(
    classifyAnswer("Your call is being transferred").evidence,
    "transfer-announcement",
  );
  assert.equal(
    classifyAnswer("Your call has been forwarded to voicemail").kind,
    "voicemail",
  );
  assert.equal(
    classifyAnswer(
      "You said your call is being transferred, what does that mean?",
    ).kind,
    "human",
  );
  assert.equal(classifyAnswer("Can you transfer me to sales?").kind, "human");
});

test("transfer wait defaults and tool overrides are bounded and survive validation", () => {
  assert.equal(callHandlingSchema.parse({}).transferWaitSeconds, 120);
  assert.equal(
    callHandlingSchema.safeParse({ transferWaitSeconds: 0 }).success,
    false,
  );
  assert.equal(
    callHandlingSchema.safeParse({ transferWaitSeconds: 301 }).success,
    false,
  );
  const tool = toolSchema.parse({
    type: "dtmf",
    name: "keypad",
    description: "Sales",
    navigation: { transferWaitSeconds: 60 },
  });
  assert.equal(
    tool.type === "dtmf" && tool.navigation?.transferWaitSeconds,
    60,
  );
});

test("a short voicemail invitation plus a beep confirms voicemail and honors its configured action", () => {
  for (const action of ["leave-message", "hangup"] as const) {
    const h = new CallHandling(
      agent({
        voicemailDetection: { enabled: true, action, message: "Call back" },
      }),
      new CallTrace(`CA-${action}`),
      true,
      true,
      0,
    );
    h.ringback(observation, 0);
    h.observe("Please leave a message.", true, 119900);
    assert.equal(h.tick(120000).action, "none");
    assert.equal(h.awaitingBeep, true);
    assert.equal(h.beep(120500).action, action);
    assert.equal(h.state, action === "hangup" ? "ended" : "voicemail-speaking");
  }
});

test("a beep alone, stale invitation, disabled detection or stricter threshold cannot confirm voicemail", () => {
  for (const variant of [
    "no-invitation",
    "expired",
    "disabled",
    "strict",
    "human",
  ] as const) {
    const h = new CallHandling(
      agent({
        voicemailDetection: {
          enabled: variant !== "disabled",
          confidenceThreshold: variant === "strict" ? 1 : 0.85,
          action: "leave-message",
          message: "Call back",
        },
      }),
      new CallTrace(`CA-${variant}`),
      true,
      true,
      0,
    );
    h.ringback(observation, 0);
    if (variant !== "no-invitation")
      h.observe("Please leave a message", true, 1000);
    if (variant === "human")
      h.observe("Hello, this is Sam speaking", true, 1500);
    assert.equal(h.beep(variant === "expired" ? 12000 : 2000).action, "none");
  }
});

test("session detects audio ringback, pauses ordinary idle timeout, and resumes on a human", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const trace = new CallTrace("CA-session-ring");
  const h = harness({
    direction: "outbound",
    trace,
    agent: agent({ silenceTimeoutSeconds: 10 }),
  });
  t.after(() => h.session.close());
  await Promise.resolve();
  const audio = ringAudio();
  for (let i = 0; i < audio.length; i += 160) {
    h.session.pushAudio(audio.subarray(i, i + 160).toString("base64"));
    t.mock.timers.tick(20);
  }
  t.mock.timers.tick(20000);
  assert.deepEqual(h.ended, []);
  assert.deepEqual(h.spoken, []);
  assert.ok(
    trace
      .view()
      .events.some((event) => event.event === "call.ringback_detected"),
  );
  h.events.onEnd("Hello, how can I help?");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(h.spoken.length > 0);
});

test("session confirms a short greeting from streamed beep audio after a transfer", async (t) => {
  const h = harness({ direction: "outbound", agent: configured() });
  t.after(() => h.session.close());
  await Promise.resolve();
  h.events.onEnd("Your call is being transferred.");
  h.events.onEnd("Please leave a message.");
  const audio = ringAudio([1000], 300, 100).subarray(0, 3200);
  for (let i = 0; i < audio.length; i += 160)
    h.session.pushAudio(audio.subarray(i, i + 160).toString("base64"));
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.deepEqual(h.spoken, ["Please call back."]);
  assert.deepEqual(h.ended, ["voicemail"]);
});

test("maximum call duration still ends a call even while transfer wait has time remaining", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const h = harness({
    direction: "outbound",
    agent: agent({
      maxDurationSeconds: 30,
      callHandling: { transferWaitSeconds: 120 },
    }),
  });
  t.after(() => h.session.close());
  await Promise.resolve();
  h.events.onEnd("Your call is being transferred.");
  t.mock.timers.tick(30000);
  assert.deepEqual(h.ended, ["max-duration"]);
});
