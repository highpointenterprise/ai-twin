import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "mongodb";
import { workspaceEnvironment, workspaceIdentity } from "./identity";

export interface WorkspacePorts { admin: number; public: number }
export class WorkspacePool {
  private workers = new Map<string, { child: ChildProcess; ready: Promise<WorkspacePorts>; lastUsed: number; busy: boolean }>();
  constructor(private readonly db: Db, private readonly base: NodeJS.ProcessEnv, private readonly maximum = 32) {
    this.sweeper = setInterval(() => {
      for (const entry of this.workers.values()) {
        if (!entry.busy && entry.child.connected && Date.now() - entry.lastUsed > 15 * 60_000) { entry.busy = true; entry.child.send({ type: "stop-if-idle" }); }
      }
    }, 30_000);
    this.sweeper.unref();
  }
  private readonly sweeper: NodeJS.Timeout;
  async get(userId: string, create: boolean): Promise<WorkspacePorts> {
    const identity = workspaceIdentity(userId, this.base);
    const workspaces = this.db.collection("workspaces");
    if (create) {
      await workspaces.updateOne({ _id: userId as never }, { $setOnInsert: { ...identity, createdAt: new Date() } }, { upsert: true });
    } else if (!(await workspaces.findOne({ _id: userId as never }))) {
      throw new Error("Unknown workspace.");
    }
    const existing = this.workers.get(userId);
    if (existing) { existing.lastUsed = Date.now(); return existing.ready; }
    if (this.workers.size >= this.maximum) throw new Error("Workspace capacity reached.");
    const production = existsSync(resolve("server/dist/worker.js")) && this.base.NODE_ENV === "production";
    const child = fork(resolve(production ? "server/dist/worker.js" : "server/worker.ts"), [], {
      env: workspaceEnvironment(userId, this.base),
      execArgv: production ? [] : ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const ready = new Promise<WorkspacePorts>((resolveReady, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Workspace startup timed out.")); }, 45_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => {
        clearTimeout(timeout);
        this.workers.delete(userId);
        reject(new Error("Workspace stopped."));
      });
      child.on("message", (message: unknown) => {
        const value = message as { type?: string; admin?: number; public?: number; busy?: boolean };
        const entry = this.workers.get(userId);
        if (value.type === "activity" && entry) entry.busy = value.busy !== false;
        if (value.type === "ready" && Number.isInteger(value.admin) && Number.isInteger(value.public)) {
          clearTimeout(timeout);
          resolveReady({ admin: value.admin!, public: value.public! });
        }
      });
    });
    this.workers.set(userId, { child, ready, lastUsed: Date.now(), busy: true });
    return ready;
  }
  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.workers.values()].map(({ child }) => new Promise<void>((resolveDone) => {
      if (child.exitCode !== null) return resolveDone();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.once("exit", () => { clearTimeout(deadline); resolveDone(); });
      child.kill("SIGTERM");
    })));
  }
}
