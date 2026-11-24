import { actionTokenSchema, emailRequestSchema, resetPasswordSchema } from "@/lib/auth";
import { authRequest, BackendError, sameOrigin } from "@/lib/backend";
import { limitedBody } from "@/lib/request-body";
const schemas = { "forgot-password": emailRequestSchema, "resend-verification": emailRequestSchema, "verify-email": actionTokenSchema, "reset-password": resetPasswordSchema, "confirm-email": actionTokenSchema };
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403, headers });
  const { action } = await context.params;
  if (!Object.hasOwn(schemas, action)) return Response.json({ error: "Not found." }, { status: 404, headers });
  try {
    const parsed = schemas[action as keyof typeof schemas].safeParse(JSON.parse(await limitedBody(request)));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0].message }, { status: 400, headers });
    const body = await authRequest(action, parsed.data);
    return Response.json(body, { status: action === "forgot-password" || action === "resend-verification" ? 202 : 200, headers });
  } catch (e) {
    if (e instanceof BackendError) { if (e.retryAfter) headers["Retry-After"] = e.retryAfter; return Response.json({ error: e.message }, { status: e.status, headers }); }
    const status = e instanceof SyntaxError ? 400 : e instanceof Error && e.message === "BodyTooLarge" ? 413 : 503;
    return Response.json({ error: status === 503 ? "Account service is temporarily unavailable." : "Invalid request." }, { status, headers });
  }
}
