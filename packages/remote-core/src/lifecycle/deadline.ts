/** Resolve with `p`'s value, or undefined once `ms` passes or `signal` aborts — whichever is first. */
export function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
