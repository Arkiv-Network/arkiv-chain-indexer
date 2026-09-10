/**
 * What an internal error may tell a client. Errors raised by the Postgres
 * driver name columns, types and the offending value, so they are logged here
 * and replaced by a generic line; anything else keeps its message, since those
 * are thrown by our own code with the client in mind.
 */
export function isDatabaseError(error: unknown): boolean {
  return error instanceof Error && error.name === "PostgresError";
}

export function publicErrorMessage(error: unknown, context: string): string {
  if (isDatabaseError(error)) {
    console.error(`${context}: database query failed:`, error);
    return "database query failed";
  }
  return error instanceof Error ? error.message : String(error);
}
