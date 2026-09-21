/**
 * Serialize async UI requests so only the newest one may write state.
 *
 * The skill market's preview fetch had no request identity: pick A, close,
 * pick B, and a slow A response would still land — the confirmation sheet
 * then showed A's body for B's install. `begin` issues a token per request;
 * only a token that is still current may commit. `invalidate` represents the
 * close/reopen path where no in-flight response may land at all.
 */
export class LatestWinsGate {
  private current = 0;

  begin(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(token: number): boolean {
    return token === this.current;
  }

  invalidate(): void {
    this.current += 1;
  }
}
