/** Require consecutive observations for one immutable genesis/dump identity. */
export class GenesisCountMismatchConfirmation {
  private previous: string | null = null;

  observe(identity: string | null): boolean {
    const confirmed = identity !== null && this.previous === identity;
    this.previous = identity;
    return confirmed;
  }
}

export function bootstrapPollInterval(status: string): number {
  // Free scratch space does not change in seconds; it waits as long as terminal states.
  return status === "done" || /^(refused|failed|insufficient scratch space):/.test(status) ? 60_000 : 5_000;
}
