import { backendFetch, sameOrigin } from "@/lib/backend";
import { backendSessionToken } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) {
    return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const token = await backendSessionToken();
  if (!token) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const { path } = await params;
  if (!path.length || path.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part)) || path[0] === "v1") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const response = await backendFetch(`/api/${path.join("/")}${new URL(request.url).search}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(request.headers.has("content-type") ? { "Content-Type": request.headers.get("content-type")! } : {}),
      },
      ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
    });
    const outgoing = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["content-type", "content-disposition", "x-next-cursor", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return Response.json({ error: "The server is temporarily unavailable. Please try again." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD };
