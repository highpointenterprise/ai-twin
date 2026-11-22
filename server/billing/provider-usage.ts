import type { CallUsage, ProviderUsageRequest } from "../../lib/types";
import { env } from "../../lib/env";

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);
export class ProviderUsageReconciler {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async json(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ body?: any; unavailable?: boolean }> {
    const response = await this.request(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      return { unavailable: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Provider usage is not available yet.");
    }
    return { body: await response.json() };
  }
  async reconcile(
    usage: CallUsage,
    prior?: CallUsage,
  ): Promise<{ usage: CallUsage; retryReasons: string[] }> {
    const result = structuredClone(usage),
      retryReasons: string[] = [];
    const old = new Map((prior?.requests ?? []).map((r) => [r.id, r]));
    result.requests = (result.requests ?? []).map((entry) => {
      const saved = old.get(entry.id);
      return saved?.reconciliation === "matched"
        ? {
            ...entry,
            usd: saved.usd,
            credits: saved.credits,
            reportedQuantity: saved.reportedQuantity,
            reconciliation: "matched",
          }
        : entry;
    });
    const pending = result.requests.filter(
      (r) => r.reconciliation !== "matched" && r.quantity > 0,
    );
    const reconcileDeepgram = async (entry: ProviderUsageRequest) => {
      if (
        !env.DEEPGRAM_PROJECT_ID ||
        !entry.providerRequestId ||
        !validId(entry.providerRequestId)
      ) {
        entry.reconciliation = "unavailable";
        return;
      }
      try {
        const response = await this.json(
          `https://api.deepgram.com/v1/projects/${encodeURIComponent(env.DEEPGRAM_PROJECT_ID)}/requests/${encodeURIComponent(entry.providerRequestId)}`,
          { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
        );
        if (response.unavailable) {
          entry.reconciliation = "unavailable";
          return;
        }
        const request = response.body?.request ?? response.body;
        if (request?.request_id !== entry.providerRequestId)
          throw new Error("Usage identity mismatch");
        const details = request?.response?.details;
        if (!nonnegative(details?.usd)) throw new Error("Charge pending");
        entry.usd = details.usd;
        const seconds =
          details.total_audio ??
          (nonnegative(details.duration) && nonnegative(details.channels)
            ? details.duration * details.channels
            : undefined);
        if (nonnegative(seconds)) entry.reportedQuantity = seconds;
        entry.reconciliation = "matched";
      } catch {
        entry.reconciliation = "pending";
        retryReasons.push("Transcription request charges are pending.");
      }
    };
    const transcription = pending.filter((r) => r.provider === "deepgram");
    for (let start = 0; start < transcription.length; start += 4)
      await Promise.all(
        transcription.slice(start, start + 4).map(reconcileDeepgram),
      );
    const voice = pending.filter((r) => r.provider === "elevenlabs");
    const ids = new Map<string, ProviderUsageRequest>();
    for (const entry of voice) {
      if (entry.providerRequestId && validId(entry.providerRequestId))
        ids.set(entry.providerRequestId, entry);
      else entry.reconciliation = "unavailable";
    }
    if (ids.size) {
      const oldest =
        Math.floor(
          Math.min(...voice.map((r) => Date.parse(r.startedAt))) / 1000,
        ) - 60;
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 10 && ids.size; page++) {
          const query = new URLSearchParams({
            page_size: "100",
            date_after_unix: String(oldest),
            ...(cursor ? { start_after_history_item_id: cursor } : {}),
          });
          const response = await this.json(
            `https://api.elevenlabs.io/v1/history?${query}`,
            { "xi-api-key": env.ELEVENLABS_API_KEY },
          );
          if (response.unavailable) {
            for (const entry of ids.values())
              entry.reconciliation = "unavailable";
            ids.clear();
            break;
          }
          if (!Array.isArray(response.body?.history))
            throw new Error("History pending");
          for (const item of response.body.history) {
            const entry = ids.get(item.request_id);
            if (
              !entry ||
              !nonnegative(item.character_count_change_from) ||
              !nonnegative(item.character_count_change_to)
            )
              continue;
            entry.credits = Math.abs(
              item.character_count_change_to - item.character_count_change_from,
            );
            entry.reconciliation = "matched";
            ids.delete(item.request_id);
          }
          if (
            !response.body.has_more ||
            !response.body.last_history_item_id ||
            response.body.last_history_item_id === cursor
          )
            break;
          cursor = response.body.last_history_item_id;
        }
      } catch {
        /* Matched generations remain durable when later pages are unavailable. */
      }
      for (const entry of ids.values()) {
        entry.reconciliation = "pending";
        retryReasons.push("Voice generation credits are pending.");
      }
    }
    return { usage: result, retryReasons: [...new Set(retryReasons)] };
  }
}
