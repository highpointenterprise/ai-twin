import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { toolSchema, type ToolConfig, type ToolInput } from "../../lib/config";
import { HttpError } from "../core/errors";
import { JsonFile } from "../store/persistence";
import type { Awaitable, ConfigPage } from "../store/agents";
export interface ToolRepository {
  list(page?: ConfigPage): Awaitable<ToolConfig[]>;
  get(id: string): Awaitable<ToolConfig>;
  resolve(ids: string[]): Awaitable<ToolConfig[]>;
  save(input: ToolInput, id?: string): Awaitable<ToolConfig>;
  delete(id: string): Awaitable<void>;
}
export const jsonValidator = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
export function validatedTool(input: ToolInput): ToolInput {
  const parsed = toolSchema.parse(input);
  if (parsed.type === "function") {
    if (parsed.parameters.type !== "object")
      throw new HttpError(400, "Function parameters must be an object JSON Schema.");
    try {
      jsonValidator.compile(parsed.parameters);
    } catch {
      throw new HttpError(400, "Invalid function parameters JSON Schema.");
    }
  }
  return parsed;
}
export class ToolRegistry implements ToolRepository {
  private readonly file: JsonFile<ToolConfig[]>;
  private readonly tools: Map<string, ToolConfig>;
  constructor(path?: string) {
    this.file = new JsonFile(path);
    this.tools = new Map(
      this.file
        .load([])
        .map((t) => [t.id, { ...toolSchema.parse(t), id: t.id }]),
    );
  }
  list(page?: ConfigPage): ToolConfig[] {
    const values = [...this.tools.values()];
    if (!page) return values;
    return values.filter((tool) => !page.after || tool.id > page.after)
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, page.limit ?? 100);
  }
  get(id: string): ToolConfig {
    const t = this.tools.get(id);
    if (!t) throw new HttpError(404, "Tool not found.");
    return t;
  }
  resolve(ids: string[]): ToolConfig[] {
    return ids.map((id) => this.get(id));
  }
  save(input: ToolInput, id: string = randomUUID()): ToolConfig {
    const parsed = validatedTool(input);
    if (this.list().some((t) => t.name === parsed.name && t.id !== id))
      throw new HttpError(409, "Tool names must be unique.");
    const t = { ...parsed, id };
    this.tools.set(id, t);
    this.file.save(this.list());
    return t;
  }
  delete(id: string): void {
    this.get(id);
    this.tools.delete(id);
    this.file.save(this.list());
  }
}
