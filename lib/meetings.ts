import { z } from "zod";

export const meetingInputSchema = z.object({
  agentId: z.string().uuid(),
  meetingUrl: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname === "meet.google.com" &&
          !url.port &&
          !url.username &&
          !url.password &&
          /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)
        );
      } catch {
        return false;
      }
    }, "Use a Google Meet link such as https://meet.google.com/abc-defg-hij.")
    .transform((value) => {
      const u = new URL(value);
      return `https://meet.google.com${u.pathname.replace(/\/$/, "")}`;
    }),
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarEnabled: z.boolean().default(false),
  avatarId: z.string().trim().max(200).default(""),
  context: z.string().trim().max(10000).default(""),
  joinTimeoutSeconds: z.number().int().min(30).max(600).default(180),
  maxDurationSeconds: z.number().int().min(60).max(7200).default(1800),
  idleTimeoutSeconds: z.number().int().min(30).max(1800).default(300),
});
export type MeetingInput = z.infer<typeof meetingInputSchema>;
export type MeetingPhase =
  | "joining"
  | "waiting"
  | "starting-avatar"
  | "active"
  | "leaving"
  | "ended"
  | "failed"
  | "needs-login";
export interface MeetingRecord extends MeetingInput {
  id: string;
  displayName: string;
  phase: MeetingPhase;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}
export interface MeetingReadiness {
  missing: string[];
  avatarMissing: string[];
  defaultAvatarId: string;
  maxConcurrentMeetings: number;
}
