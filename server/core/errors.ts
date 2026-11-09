export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const logError = (error: unknown): void => {
  writeDiagnostic("system", "operation.failed", errorDetail(error));
};
import { errorDetail, writeDiagnostic } from "../observability/diagnostics";
