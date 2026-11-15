import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

test("configuration loads dotenv even when diagnostics is imported first", () => {
  const folder = mkdtempSync(join(tmpdir(), "env-loading-"));
  try {
    const file = join(folder, ".env");
    writeFileSync(file, "REDIS_URL=redis://redis.example.test:16379\n");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: file };
    delete childEnv.REDIS_URL;
    const result = execFileSync(process.execPath, ["-r", "tsx/cjs", "-e",
      `require(${JSON.stringify(resolve("server/observability/diagnostics.ts"))}); console.log(require(${JSON.stringify(resolve("lib/env.ts"))}).env.REDIS_URL);`
    ], { env: childEnv, encoding: "utf8" });
    assert.equal(result.trim(), "redis://redis.example.test:16379");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
