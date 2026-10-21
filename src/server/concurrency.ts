import type { Runtime } from "../shared/types.ts";

/** Reserve before resolving; queued callers cannot race past provider limits. */
export function createCallSlots(total: number, perProvider: number) {
  const active = new Map<symbol, Runtime>();
  type Waiter = { token: symbol; runtime: Runtime; signal?: AbortSignal; start: () => void; abort: () => void };
  const queue: Waiter[] = [];
  const drain = () => {
    for (const waiter of [...queue]) {
      if (active.size >= total) break;
      if ([...active.values()].filter((runtime) => runtime === waiter.runtime).length >= perProvider) continue;
      queue.splice(queue.indexOf(waiter), 1);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      active.set(waiter.token, waiter.runtime);
      waiter.start();
    }
  };
  return (runtime: Runtime, signal?: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("cancelled")); return; }
    const token = Symbol(runtime);
    const waiter: Waiter = {
      token, runtime, signal,
      start: () => resolve(() => { if (active.delete(token)) drain(); }),
      abort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal?.reason ?? new Error("cancelled"));
      },
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    queue.push(waiter);
    drain();
  });
}
