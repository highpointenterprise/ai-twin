import { Readable } from "node:stream";
import type { ObjectStore, StoredObject } from "../server/storage/objects";
export function recordingWav(channels = 2, seconds = 2): Buffer {
  const rate = 8000,
    samples = rate * seconds;
  const body = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples; i++)
    for (let channel = 0; channel < channels; channel++)
      body.writeInt16LE(
        Math.round(
          4000 * Math.sin((2 * Math.PI * (channel ? 880 : 440) * i) / rate),
        ),
        (i * channels + channel) * 2,
      );
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(body.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}
export function pcm(data: Buffer) {
  if (
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Not WAV audio");
  let channels = 0;
  let samples: Buffer = Buffer.alloc(0);
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4),
      name = data.toString("ascii", offset, offset + 4);
    if (name === "fmt ") channels = data.readUInt16LE(offset + 10);
    if (name === "data") samples = data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return { channels, samples };
}
export function recordingObjects() {
  const files = new Map<string, Buffer>();
  const put = async (
    key: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<StoredObject> => {
    files.set(key, bytes);
    return {
      key,
      size: bytes.length,
      bucket: "private",
      contentType,
      createdAt: new Date().toISOString(),
    };
  };
  const objects = {
    put: (key: string, bytes: string | Buffer, contentType: string) =>
      put(key, Buffer.from(bytes), contentType),
    putStream: async (
      key: string,
      stream: AsyncIterable<Uint8Array>,
      contentType: string,
    ) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return put(key, Buffer.concat(chunks), contentType);
    },
    read: async (key: string) => {
      if (!files.has(key)) throw new Error("Missing object");
      return Readable.from([files.get(key)!]);
    },
    signedUrl: async (key: string, seconds: number, disposition: string) =>
      `https://storage.example/${key}?expires=${seconds}&disposition=${disposition}`,
  } as unknown as ObjectStore;
  return { objects, files };
}
