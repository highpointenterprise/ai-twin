export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Your session has expired. Please log in again.");
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error((Array.isArray(body.message) ? body.message.join("; ") : body.message) || body.error || `Request failed (${response.status}).`);
  return body as T;
}

export async function apiList<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  const seen = new Set<string>();
  do {
    const response = await fetch(
      `/api/backend${path}?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
      { cache: "no-store" },
    );
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("Please log in again.");
    }
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Cannot load your workspace.");
    items.push(...(body as T[]));
    cursor = response.headers.get("X-Next-Cursor") || "";
    if (cursor && seen.has(cursor))
      throw new Error("Unable to load the next page. Please retry.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
