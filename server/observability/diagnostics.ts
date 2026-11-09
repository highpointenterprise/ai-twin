import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { env } from "../../lib/env";
import type { TraceEvent } from "../../lib/types";

export interface DiagnosticEvent extends TraceEvent {
  scope: string;
}
const sensitiveKey =
  /token|secret|password|authorization|api.?key|cookie|signature|payload|raw.?audio/i;
export function redactText(value: string): string {
  let text = value;
  for (const [key, secret] of Object.entries({ ...process.env, ...env }))
    if (
      sensitiveKey.test(key) &&
      typeof secret === "string" &&
      secret.length >= 4
    )
      text = text.split(secret).join("[redacted]");
  return text
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9_+./=-]+/gi, "$1 [redacted]")
    .replace(
      /([?&](?:token|key|signature|api_key|access_token)=)[^\s&#"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /("?(?:api[_-]?key|xi-api-key|auth[_-]?token|authorization|password|secret|cookie)"?\s*[:=]\s*")[^"]*"/gi,
      '$1[redacted]"',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
export function safeDetail(detail: TraceEvent["detail"]): TraceEvent["detail"] {
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, 40)
      .map(([key, value]) => [
        key,
        typeof value === "string"
          ? sensitiveKey.test(key)
            ? "[redacted]"
            : redactText(value).slice(0, 1500)
          : value,
      ]),
  );
}
export function errorDetail(error: unknown): TraceEvent["detail"] {
  const e = error as
    | {
        message?: unknown;
        name?: string;
        code?: string | number;
        status?: number;
      }
    | undefined;
  return safeDetail({
    message: typeof e?.message === "string" ? e.message : "Unknown error",
    ...(e?.name ? { error_type: e.name } : {}),
    ...(e?.code !== undefined ? { code: String(e.code) } : {}),
    ...(typeof e?.status === "number" ? { status: e.status } : {}),
  });
}

// Bounded, rotating JSONL. Logging failure must never stop live call handling.
export class DiagnosticLog {
  private entries: DiagnosticEvent[] = [];
  private size = 0;
  private writable = true;
  constructor(
    readonly path?: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const file of [`${path}.2`, `${path}.1`, path]) {
        try {
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line) continue;
            try {
              const item = JSON.parse(line) as DiagnosticEvent;
              if (
                typeof item.at === "number" &&
                typeof item.scope === "string" &&
                typeof item.event === "string" &&
                item.detail
              )
                this.entries.push({ ...item, detail: safeDetail(item.detail) });
            } catch {}
          }
        } catch {}
      }
      this.entries = this.entries.slice(-2000);
      try {
        this.size = statSync(path).size;
      } catch {}
    } catch {
      this.writable = false;
      console.error(
        "diagnostics.storage_unavailable: check DATA_DIR permissions",
      );
    }
  }
  append(event: DiagnosticEvent): void {
    const entry = { ...event, detail: safeDetail(event.detail) };
    this.entries.push(entry);
    if (this.entries.length > 2000) this.entries.shift();
    if (!this.path || !this.writable) return;
    try {
      const line = JSON.stringify(entry) + "\n",
        bytes = Buffer.byteLength(line);
      if (this.size + bytes > this.maxBytes) {
        rmSync(`${this.path}.2`, { force: true });
        try {
          renameSync(`${this.path}.1`, `${this.path}.2`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        try {
          renameSync(this.path, `${this.path}.1`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        this.size = 0;
      }
      appendFileSync(this.path, line, { mode: 0o600 });
      this.size += bytes;
    } catch {
      this.writable = false;
      console.error(
        "diagnostics.write_failed: file logging stopped; console and in-memory logs remain available",
      );
    }
  }
  list(scope?: string, limit = 300): DiagnosticEvent[] {
    return this.entries
      .filter((e) => !scope || e.scope === scope)
      .slice(-Math.min(2000, Math.max(1, limit)));
  }
}
let log = new DiagnosticLog();
export function configureDiagnostics(path: string): void {
  log = new DiagnosticLog(path);
}
export function diagnosticEvents(
  scope?: string,
  limit?: number,
): DiagnosticEvent[] {
  return log.list(scope, limit);
}
export function writeDiagnostic(
  scope: string,
  event: string,
  detail: TraceEvent["detail"] = {},
): void {
  const entry = {
    at: Date.now(),
    scope: redactText(scope).slice(0, 160),
    event,
    detail: safeDetail(detail),
  };
  log.append(entry);
  console.log(
    `${new Date(entry.at).toISOString()} [${entry.scope}] ${event} ${JSON.stringify(entry.detail)}`,
  );
}
