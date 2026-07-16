/**
 * chainedTimeout: a setTimeout toward an absolute deadline that re-arms past
 * Node's 2^31−1 ms per-timer range — an oversized delay is honored, never
 * silently disarmed and never overflow-fired at ~1ms. The timer is unref'd:
 * it never keeps the process alive on its own.
 */
export function chainedTimeout(delayMs: number, onFire: () => void): { clear(): void } {
  const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
  const deadline = Date.now() + delayMs;
  let handle: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const remaining = deadline - Date.now();
    handle =
      remaining <= MAX_TIMER_DELAY_MS ? setTimeout(onFire, Math.max(0, remaining)) : setTimeout(arm, MAX_TIMER_DELAY_MS);
    handle.unref();
  };
  arm();
  return { clear: (): void => clearTimeout(handle) };
}
