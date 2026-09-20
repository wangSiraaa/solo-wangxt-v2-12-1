export type ReleaseState =
  | 'draft'
  | 'waiting_canary'
  | 'paused'
  | 'running'
  | 'succeeded'
  | 'partial_failed'
  | 'failed'
  | 'superseded'
  | 'cancelling'
  | 'cancel_partial'
  | 'cancelled'
  | 'rolling_back'
  | 'rolled_back';

export type NodeReleaseState =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'superseded'
  | 'restoring'
  | 'restored'
  | 'restore_skipped';

export interface ConflictNode {
  nodeId: string;
  nodeName: string;
  domain: string;
  releaseId: string;
  releaseState: ReleaseState;
  priority: 'normal' | 'emergency';
  state: NodeReleaseState;
  generation: number;
  currentCertId: string | null;
  previousCertId: string | null;
}

export interface CreateReleaseDto {
  priority: 'normal' | 'emergency';
  domain: string;
  certVersion: string;
  nodeIds: string[];
  reason?: string;
  createdBy?: string;
  canary?: boolean;
  emergencyReleaseId?: string;
}

export interface ReceiptDto {
  success: boolean;
  detail?: string;
}
