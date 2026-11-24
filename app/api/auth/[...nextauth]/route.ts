import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth-options";
import { sameOrigin } from "@/lib/backend";
import { limitedBody } from "@/lib/request-body";
export const runtime = "nodejs";
const handler = NextAuth(authOptions);
export { handler as GET };
export async function POST(request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  try {
    const body = await limitedBody(request, 8192);
    return await handler(new NextRequest(request.url, { method: "POST", headers: request.headers, body }), context);
  } catch (e) {
    return Response.json({ error: "Unable to process authentication request." }, { status: e instanceof Error && e.message === "BodyTooLarge" ? 413 : 503 });
  }
}
