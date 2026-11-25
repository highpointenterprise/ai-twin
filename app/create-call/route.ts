import { POST as proxy } from "../api/backend/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return proxy(request, { params: Promise.resolve({ path: ["create-call"] }) });
}
