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
  return status === "done" || /^(refused|failed):/.test(status) ? 60_000 : 5_000;
}
