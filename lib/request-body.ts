export async function limitedBody(request: Request, limit = 4096): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new Error("BodyTooLarge");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error("BodyTooLarge"); }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
