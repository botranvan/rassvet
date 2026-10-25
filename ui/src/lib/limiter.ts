/**
 * Runs at most `max` tasks at once; waiting tasks start lowest `priority` first (FIFO
 * among equals), so the calls of one table row can share a priority and finish together.
 * A queued task whose signal is aborted (its query was cancelled, e.g. the page was left)
 * is dropped before it starts, so leaving a page with hundreds of queued calls costs nothing.
 */
export function limiter(max: number) {
  let active = 0;
  const queue: { priority: number; start: () => void }[] = [];
  const next = () => {
    while (active < max && queue.length) queue.shift()!.start();
  };
  return function run<T>(task: () => Promise<T>, opts?: { signal?: AbortSignal; priority?: number }): Promise<T> {
    const signal = opts?.signal;
    const priority = opts?.priority ?? Number.MAX_SAFE_INTEGER;
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      // Insert after the last task with the same or a lower priority.
      let i = queue.length;
      while (i > 0 && queue[i - 1].priority > priority) i--;
      queue.splice(i, 0, { priority, start });
      next();
    });
  };
}
