/** Minimal typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<(d: never) => void>>();
  on<K extends keyof E>(type: K, fn: (data: E[K]) => void): () => void {
    let s = this.handlers.get(type);
    if (!s) this.handlers.set(type, (s = new Set()));
    s.add(fn as (d: never) => void);
    return () => this.off(type, fn);
  }
  off<K extends keyof E>(type: K, fn: (data: E[K]) => void) {
    this.handlers.get(type)?.delete(fn as (d: never) => void);
  }
  once<K extends keyof E>(type: K, fn: (data: E[K]) => void) {
    const off = this.on(type, (d) => {
      off();
      fn(d);
    });
    return off;
  }
  emit<K extends keyof E>(type: K, data: E[K]) {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        (fn as (d: E[K]) => void)(data);
      } catch (err) {
        console.error(`[robot] handler for "${String(type)}" threw`, err);
      }
    });
    this.handlers.get("*" as keyof E)?.forEach((fn) => (fn as (d: unknown) => void)({ type, data }));
  }
}
