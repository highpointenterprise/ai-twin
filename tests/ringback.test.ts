import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RingbackDetector,
  type RingbackObservation,
} from "../server/calls/ringback";
import { decodeMulaw, encodeMulaw, dtmfAudio } from "../server/speech/audio";
import { ringAudio } from "./ringback-fixture";

test("ringback requires matching tone frequencies and a complete cadence", () => {
  for (const format of [
    { encoding: "mulaw", sampleRate: 8000 },
    { encoding: "pcm_s16le", sampleRate: 16000 },
  ] as const) {
    const detector = new RingbackDetector(format);
    const audio = ringAudio([440, 480], 2000, 4000, format);
    const observations: RingbackObservation[] = [];
    for (let i = 0; i < audio.length; i += 73) {
      const match = detector.push(audio.subarray(i, i + 73));
      if (match) observations.push(match);
      if (
        i <
        ((6000 * format.sampleRate) / 1000) *
          (format.encoding === "mulaw" ? 1 : 2)
      )
        assert.equal(observations.length, 0);
    }
    assert.equal(observations.length, 1);
    assert.equal(observations[0].profile, "north-america");
    assert.ok(Math.abs(observations[0].toneMs - 2000) <= 160);
    assert.ok(Math.abs(observations[0].silenceMs - 4000) <= 160);
  }
  assert.equal(
    new RingbackDetector().push(ringAudio([425], 1000, 4000))?.profile,
    "425hz",
  );
});

test("ringback rejects keypad tones, voicemail beeps, busy cadence, constant tones and broadband audio", () => {
  const examples = [
    dtmfAudio("1234567890*#", 200, 100),
    ringAudio([1000], 300, 4000),
    ringAudio([480, 620], 500, 500),
    ringAudio([440, 480], 500, 500),
    ringAudio([440, 480], 8000, 0),
    ringAudio([440], 2000, 4000),
    Buffer.alloc(80000, 255),
    Buffer.from(
      Array.from({ length: 80000 }, (_, i) =>
        encodeMulaw(6000 * Math.sin(i * i)),
      ),
    ),
  ];
  for (const audio of examples)
    assert.equal(new RingbackDetector().push(audio), undefined);
});

test("ringback tolerates frame offsets, modest frequency drift and low background noise", () => {
  for (const drift of [0.99, 1.01]) {
    const audio = Buffer.concat([
      Buffer.alloc(137, 255),
      ringAudio([440 * drift, 480 * drift], 1957, 3971),
    ]);
    for (let i = 0; i < audio.length; i++)
      audio[i] = encodeMulaw(
        decodeMulaw(audio[i]) + Math.round(150 * Math.sin(i * i)),
      );
    assert.equal(new RingbackDetector().push(audio)?.profile, "north-america");
  }
});

test("speech or music in the gap and a reset prevent a stale tone from completing a ring cadence", () => {
  const audio = ringAudio();
  audio.fill(encodeMulaw(6000), 24000, 32000);
  assert.equal(new RingbackDetector().push(audio), undefined);
  const detector = new RingbackDetector();
  detector.push(ringAudio().subarray(0, 48000));
  detector.reset();
  assert.equal(detector.push(ringAudio().subarray(48000)), undefined);
});
