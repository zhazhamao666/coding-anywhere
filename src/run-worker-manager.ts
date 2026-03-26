import { ThreadRunGuard } from "./thread-run-guard.js";

interface QueueItem {
  concurrencyKey: string;
  worker: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export class RunWorkerManager {
  private readonly guard = new ThreadRunGuard();
  private readonly queue: QueueItem[] = [];
  private activeCount = 0;

  public constructor(
    private readonly config: {
      maxConcurrentRuns: number;
    },
  ) {}

  public schedule<T>(concurrencyKey: string, worker: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        concurrencyKey,
        worker: async () => worker(),
        resolve: value => {
          resolve(value as T);
        },
        reject,
      });
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    while (this.activeCount < this.config.maxConcurrentRuns) {
      const nextIndex = this.queue.findIndex(item => this.guard.tryAcquire(item.concurrencyKey));
      if (nextIndex === -1) {
        return;
      }

      const [next] = this.queue.splice(nextIndex, 1);
      if (!next) {
        return;
      }

      this.activeCount += 1;
      void Promise.resolve()
        .then(() => next.worker())
        .then(result => {
          next.resolve(result);
        })
        .catch(error => {
          next.reject(error);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.guard.release(next.concurrencyKey);
          this.pumpQueue();
        });
    }
  }
}
