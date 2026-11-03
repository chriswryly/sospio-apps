type Entry = { id: string; ready?: () => void; heldAt?: number; earlier?: string; deadline?: number };
/** A queue per captured window. Failed/skipped requests never block their successors. */
export class EmissionOrder {
  private queues = new Map<object, Entry[]>();
  private timers = new Map<object, ReturnType<typeof setTimeout>>();
  constructor(
    private held: (id: string, earlier: string, waitMs: number) => void,
    private expired: (window: object, id: string) => void,
    private boundMs: number,
  ) {}
  start(window: object, id: string): void {
    const queue = this.queues.get(window) ?? [];
    queue.push({ id }); this.queues.set(window, queue);
  }
  settling(window: object, id: string): void {
    const item = this.queues.get(window)?.find(item => item.id === id);
    if (item) item.deadline = Date.now() + this.boundMs;
  }
  complete(window: object, id: string, emit: () => void): void {
    const queue = this.queues.get(window);
    const item = queue?.find(item => item.id === id);
    if (!item) return; // cancelled while its asynchronous fallback was settling
    if (queue![0] !== item) { item.heldAt = Date.now(); item.earlier = queue![0].id; }
    item.ready = emit; this.drain(window);
  }
  fail(window: object, id: string): void {
    const queue = this.queues.get(window);
    if (!queue) return;
    this.queues.set(window, queue.filter(item => item.id !== id)); this.drain(window);
  }
  cancel(window: object): string[] {
    const queue = this.queues.get(window) ?? [];
    const pending = queue.filter(item => !item.ready).map(item => item.id);
    this.queues.set(window, queue.filter(item => item.ready)); this.drain(window);
    return pending;
  }
  private drain(window: object): void {
    clearTimeout(this.timers.get(window)); this.timers.delete(window);
    const queue = this.queues.get(window)!;
    while (queue?.[0]?.ready) {
      const item = queue.shift()!;
      if (item.heldAt !== undefined) this.held(item.id, item.earlier!, Date.now() - item.heldAt);
      item.ready!();
    }
    if (!queue?.length) { this.queues.delete(window); return; }
    if (queue.some(item => item.ready)) {
      // A missing transport finish must not block a completed successor forever either.
      queue[0].deadline ??= Date.now() + this.boundMs;
      const id = queue[0].id;
      this.timers.set(window, setTimeout(() => {
        this.expired(window, id);
        this.fail(window, id);
      }, Math.max(0, queue[0].deadline - Date.now())));
    }
  }
}
