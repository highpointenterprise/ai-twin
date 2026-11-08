import twilio from "twilio";
import { env } from "../../lib/env";
import type { WarmTransferRecord } from "./types";
export const transferUrl = (id: string, action: string) =>
  `${env.PUBLIC_BASE_URL}/twilio/warm/${encodeURIComponent(id)}/${action}`;
export function conferenceTwiml(
  record: WarmTransferRecord,
  role: "caller" | "operator",
): string {
  const response = new twilio.twiml.VoiceResponse();
  response
    .dial({ action: transferUrl(record.id, `${role}-exit`), method: "POST" })
    .conference(
      {
        startConferenceOnEnter: role === "operator",
        endConferenceOnExit: true,
        beep: "false",
        waitUrl: transferUrl(record.id, "wait"),
        waitMethod: "POST",
        statusCallback: transferUrl(record.id, "conference"),
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["start", "end", "join", "leave"],
        participantLabel: role,
      },
      record.room,
    );
  return response.toString();
}
export function holdTwiml(record: WarmTransferRecord): string {
  const response = new twilio.twiml.VoiceResponse();
  response.play(
    { loop: 0 },
    record.plan.holdAudioUrl ?? `${env.PUBLIC_BASE_URL}/twilio/warm-hold.wav`,
  );
  return response.toString();
}
// Generated hold audio: quiet two-note chime, followed by silence. No external audio dependency.
export function holdWav(): Buffer {
  const rate = 8000,
    count = rate * 8,
    data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const envelope = t < 1.5 ? Math.sin((Math.PI * t) / 1.5) ** 2 : 0;
    data.writeInt16LE(
      Math.round(
        envelope *
          1100 *
          (Math.sin(2 * Math.PI * 440 * t) +
            Math.sin(2 * Math.PI * 554.37 * t)),
      ),
      i * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
