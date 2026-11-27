import { encodeMulaw } from "../server/speech/audio";
import type { AudioFormat } from "../server/core/ports";

export function ringAudio(
  frequencies = [440, 480],
  onMs = 2000,
  offMs = 4000,
  format: AudioFormat = { encoding: "mulaw", sampleRate: 8000 },
) {
  const tone = (ms: number) => {
    const count = Math.round((ms * format.sampleRate) / 1000);
    const bytes = Buffer.alloc(count * (format.encoding === "mulaw" ? 1 : 2));
    for (let i = 0; i < count; i++) {
      const sample = Math.round(
        frequencies.reduce(
          (sum, hz) =>
            sum + 3000 * Math.sin((2 * Math.PI * hz * i) / format.sampleRate),
          0,
        ),
      );
      if (format.encoding === "mulaw") bytes[i] = encodeMulaw(sample);
      else bytes.writeInt16LE(sample, i * 2);
    }
    return bytes;
  };
  const silence = Buffer.alloc(
    ((offMs * format.sampleRate) / 1000) *
      (format.encoding === "mulaw" ? 1 : 2),
    format.encoding === "mulaw" ? 255 : 0,
  );
  return Buffer.concat([tone(onMs), silence, tone(onMs)]);
}
