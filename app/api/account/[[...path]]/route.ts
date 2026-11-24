import { backendFetch, sameOrigin } from "@/lib/backend";
import { backendSessionToken } from "@/lib/session";
import { limitedBody } from "@/lib/request-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (request.method !== "GET" && !sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403, headers });
  try {
    const token = await backendSessionToken();
    if (!token) return Response.json({ error: "Sign in to continue." }, { status: 401, headers });
    const path = (await context.params).path || [];
    if (path.some(p => !/^[a-zA-Z0-9_-]+$/.test(p))) return Response.json({ error: "Not found." }, { status: 404, headers });
    const body = ["POST", "PATCH"].includes(request.method) ? await limitedBody(request) : undefined;
    const response = await backendFetch(`/api/v1/auth/account${path.length ? `/${path.join("/")}` : ""}`, { method: request.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    const retry = response.headers.get("retry-after");
    if (retry) headers["Retry-After"] = retry;
    if (response.status === 204) return new Response(null, { status: 204, headers });
    return Response.json(await response.json(), { status: response.status, headers });
  } catch (e) {
    return Response.json({ error: e instanceof Error && e.message === "BodyTooLarge" ? "Request body is too large." : "Account settings are temporarily unavailable." }, { status: e instanceof Error && e.message === "BodyTooLarge" ? 413 : 503, headers });
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
