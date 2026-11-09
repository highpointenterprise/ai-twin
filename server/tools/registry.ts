import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { toolSchema, type ToolConfig, type ToolInput } from "../../lib/config";
import { HttpError } from "../core/errors";
import { JsonFile } from "../store/persistence";
export const jsonValidator = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
export class ToolRegistry {
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
  list(): ToolConfig[] {
    return [...this.tools.values()];
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
    const parsed = toolSchema.parse(input);
    if (this.list().some((t) => t.name === parsed.name && t.id !== id))
      throw new HttpError(409, "Tool names must be unique.");
    if (parsed.type === "function") {
      if (parsed.parameters.type !== "object")
        throw new HttpError(
          400,
          "Function parameters must be an object JSON Schema.",
        );
      try {
        jsonValidator.compile(parsed.parameters);
      } catch {
        throw new HttpError(400, "Invalid function parameters JSON Schema.");
      }
    }
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
