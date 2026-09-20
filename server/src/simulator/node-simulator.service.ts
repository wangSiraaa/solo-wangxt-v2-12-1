import { Injectable } from '@nestjs/common';

export interface DispatchedTask {
  id: string;
  releaseId: string;
  nodeId: string;
  generation: number;
  certId: string;
  attempt: number;
}

export interface SimReceipt {
  taskId: string;
  success: boolean;
  detail: string;
}

type ReceiptCallback = (receipt: SimReceipt) => Promise<void>;

@Injectable()
export class NodeSimulatorService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private callback: ReceiptCallback = async () => undefined;

  setReceiptCallback(callback: ReceiptCallback): void {
    this.callback = callback;
  }

  start(task: DispatchedTask, nodeBehavior: string): void {
    if (this.timers.has(task.id)) return;
    const behavior = nodeBehavior === 'late_success' ? 'late_success' : nodeBehavior === 'fail' ? 'fail' : 'succeed';
    const delay = behavior === 'late_success' ? 1500 : behavior === 'fail' ? 80 : 100;
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.callback({
        taskId: task.id,
        success: behavior !== 'fail',
        detail:
          behavior === 'fail'
            ? 'simulated node rejected certificate'
            : `simulator installed ${task.certId}${behavior === 'late_success' ? ' after timeout' : ''}`,
      });
    }, delay);
    this.timers.set(task.id, timer);
  }

  clearAfterRestart(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  pendingRequestCount(): number {
    return this.timers.size;
  }
}
