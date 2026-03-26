export class ThreadRunGuard {
  private readonly activeThreads = new Set<string>();

  public tryAcquire(threadId: string): boolean {
    if (this.activeThreads.has(threadId)) {
      return false;
    }

    this.activeThreads.add(threadId);
    return true;
  }

  public release(threadId: string): void {
    this.activeThreads.delete(threadId);
  }
}
