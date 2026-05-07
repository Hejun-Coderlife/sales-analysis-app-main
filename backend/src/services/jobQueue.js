export class JobQueue {
  constructor() {
    this.jobs = [];
    this.running = false;
  }

  enqueue(task) {
    this.jobs.push(task);
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length) {
      const task = this.jobs.shift();
      try {
        // Sequential processing keeps memory bounded and avoids DB write contention.
        // We can switch this to worker threads in later phases if needed.
        await task();
      } catch (_error) {
        // Task-level error handling is expected to happen inside the task function.
      }
    }
    this.running = false;
  }
}
