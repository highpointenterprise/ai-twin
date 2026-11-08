import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
export class JsonFile<T> {
  constructor(private readonly path?: string) {}
  load(fallback: T): T {
    return this.path && existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as T)
      : fallback;
  }
  save(data: T): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
