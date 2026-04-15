export class RunCanceledError extends Error {
  public constructor(message = "RUN_CANCELED") {
    super(message);
    this.name = "RunCanceledError";
  }
}

export function isRunCanceledError(error: unknown): error is RunCanceledError {
  return error instanceof RunCanceledError || (
    error instanceof Error &&
    error.message === "RUN_CANCELED"
  );
}
