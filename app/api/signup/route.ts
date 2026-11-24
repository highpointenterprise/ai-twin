import { limitedBody } from "@/lib/request-body";
import { signupSchema } from "@/lib/auth";
import { authRequest, BackendError, sameOrigin } from "@/lib/backend";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  try {
    const raw = await request.text();
    if (raw.length > 4096)
      return Response.json(
        { error: "Request body is too large." },
        { status: 413 },
      );
    const input = signupSchema.safeParse(JSON.parse(raw));
    if (!input.success)
      return Response.json(
        { error: input.error.issues[0].message },
        { status: 400 },
      );
    await authRequest("signup", input.data);
    return Response.json(
      { success: true },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid request." }, { status: 400 });
    if (
      error instanceof BackendError &&
      [400, 409, 429].includes(error.status)
    ) {
      return Response.json(
        { error: error.message },
        {
          status: error.status,
          headers: {
            "Cache-Control": "no-store",
            ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
          },
        },
      );
    }
    return Response.json(
      { error: "Signup is temporarily unavailable. Please try again." },
      { status: 503 },
    );
  }
}
