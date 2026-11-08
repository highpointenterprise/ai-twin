export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const logError = (error: unknown): void => {
  console.error(error instanceof Error ? error.message : error);
};
