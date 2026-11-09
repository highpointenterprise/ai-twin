// G.711 mu-law, 8 kHz mono: the format used by Twilio bidirectional Media Streams.
export const decodeMulaw = (value: number): number => {
  const v = ~value & 255;
  const sample = (((v & 15) << 3) + 0x84) << ((v >> 4) & 7);
  return v & 0x80 ? 0x84 - sample : sample - 0x84;
};
export const encodeMulaw = (sample: number): number => {
  const sign = sample < 0 ? 0x80 : 0;
  let value = Math.min(32635, Math.abs(sample)) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1)
    exponent--;
  return ~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15)) & 255;
};
export const audioRms = (audio: Buffer): number =>
  Math.sqrt(
    audio.reduce((n, v) => n + decodeMulaw(v) ** 2, 0) /
      Math.max(1, audio.length),
  );
const rows = [697, 770, 852, 941],
  columns = [1209, 1336, 1477, 1633],
  keys = ["123A", "456B", "789C", "*0#D"];
export function dtmfAudio(
  sequence: string,
  durationMs: number,
  gapMs: number,
): Buffer {
  if (!/^[0-9A-D*#wW]{1,32}$/.test(sequence))
    throw new Error(
      "DTMF keys must contain 1–32 digits, *, #, A–D, or w/W pauses.",
    );
  const chunks: Buffer[] = [];
  for (const key of sequence) {
    if (key === "w" || key === "W") {
      chunks.push(Buffer.alloc(key === "w" ? 4000 : 8000, 255));
      continue;
    }
    const row = keys.findIndex((k) => k.includes(key)),
      col = keys[row].indexOf(key);
    const samples = Math.round(durationMs * 8),
      tone = Buffer.alloc(samples);
    for (let i = 0; i < samples; i++) {
      const ramp = Math.min(1, i / 40, (samples - i - 1) / 40);
      tone[i] = encodeMulaw(
        Math.round(
          ramp *
            5000 *
            (Math.sin((2 * Math.PI * rows[row] * i) / 8000) +
              Math.sin((2 * Math.PI * columns[col] * i) / 8000)),
        ),
      );
    }
    chunks.push(tone, Buffer.alloc(Math.round(gapMs * 8), 255));
  }
  return Buffer.concat(chunks);
}
