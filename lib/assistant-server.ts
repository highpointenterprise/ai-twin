import { z } from "zod";

export const assistantServerSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2048)
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, "Use a public HTTPS URL without credentials or a fragment, or leave blank to disable webhooks."),
    timeoutSeconds: z.number().min(1).max(300).default(20),
  })
  .strict();
