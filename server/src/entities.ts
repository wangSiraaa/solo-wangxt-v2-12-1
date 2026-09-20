import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type CertStatus = 'valid' | 'revoked';

@Entity('certificates')
export class CertEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  domain: string;

  @Column('int')
  version: number;

  @Column('text')
  content: string;

  @Column({ default: 'valid' })
  status: CertStatus;

  @Column({ name: 'not_before', type: 'timestamptz', nullable: true })
  notBefore: Date | null;

  @Column({ name: 'not_after', type: 'timestamptz', nullable: true })
  notAfter: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('nodes')
export class NodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  /** domains this node serves; used for cert/domain matching on restore */
  @Column('jsonb')
  domains: string[];

  /** the platform's record of the cert actually on the node */
  @Column('uuid', { name: 'current_cert_id', nullable: true })
  currentCertId: string | null;

  @Column({ name: 'current_cert_version', type: 'int', nullable: true })
  currentCertVersion: number | null;

  @Column('uuid', { name: 'cert_updated_by_release_id', nullable: true })
  certUpdatedByReleaseId: string | null;

  @Column({ name: 'cert_updated_at', type: 'timestamptz', nullable: true })
  certUpdatedAt: Date | null;
}

export type ReleaseKind = 'normal' | 'emergency';
export type ReleaseStatus =
  | 'draft'
  | 'running'
  | 'gate_paused'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'rolling_back'
  | 'rolled_back'
  | 'cancelled'
  | 'superseded';

/** statuses in which a release still actively controls its nodes */
export const ACTIVE_RELEASE_STATUSES: ReleaseStatus[] = [
  'running',
  'gate_paused',
  'paused',
  'failed',
  'rolling_back',
];

export interface ReleaseStrategy {
  /** percent of nodes in the canary stage (normal releases) */
  canaryPercent: number;
  /** nodes per batch after the canary stage */
  batchSize: number;
  /** dispatch request timeout; overdue requests are marked timed_out */
  dispatchTimeoutMs: number;
  /** max dispatch attempts per task */
  maxAttempts: number;
}

@Entity('releases')
export class ReleaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ default: 'normal' })
  kind: ReleaseKind;

  /** persisted scheduling priority; emergency defaults to 100, normal to 10 */
  @Column('int', { default: 10 })
  priority: number;

  @Column({ default: 'draft' })
  status: ReleaseStatus;

  @Column('uuid', { name: 'cert_id' })
  certId: string;

  @Column('jsonb')
  strategy: ReleaseStrategy;

  /** ordered target node ids (snapshot at creation) */
  @Column('jsonb', { name: 'node_ids' })
  nodeIds: string[];

  @Column('int', { name: 'stage_index', default: 0 })
  stageIndex: number;

  /** why the release reached its current terminal/special state */
  @Column({ name: 'state_reason', type: 'text', nullable: true })
  stateReason: string | null;

  @Column('uuid', { name: 'superseded_by_release_id', nullable: true })
  supersededByReleaseId: string | null;

  /** idempotency guard: an emergency release can be taken over exactly once */
  @Column({ name: 'takeover_done', default: false })
  takeoverDone: boolean;

  @Column({ name: 'created_by', default: 'system' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

export type TaskStatus =
  | 'pending'
  | 'in_flight'
  | 'success'
  | 'failed'
  | 'superseded'
  | 'cancelled'
  | 'restoring'
  | 'rolled_back'
  | 'adopted';

@Entity('release_tasks')
@Unique(['releaseId', 'nodeId'])
export class ReleaseTaskEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'release_id' })
  @Index()
  releaseId: string;

  @Column('uuid', { name: 'node_id' })
  @Index()
  nodeId: string;

  @Column({ name: 'node_name' })
  nodeName: string;

  @Column({ default: 'pending' })
  status: TaskStatus;

  /** node control epoch at which this task was created */
  @Column('int')
  epoch: number;

  @Column('uuid', { name: 'target_cert_id' })
  targetCertId: string;

  /** cert present on the node before this task applied (for rollback/restore) */
  @Column('uuid', { name: 'prev_cert_id', nullable: true })
  prevCertId: string | null;

  @Column('int', { default: 0 })
  attempts: number;

  @Column('int', { name: 'max_attempts', default: 3 })
  maxAttempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column('uuid', { name: 'current_request_id', nullable: true })
  currentRequestId: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * Authoritative control record: exactly one row per node, pointing at the
 * single release that currently controls it, with a monotonically
 * increasing epoch. Every control transfer bumps the epoch inside the same
 * transaction that writes the switch record.
 */
@Entity('node_control')
export class NodeControlEntity {
  @Column('uuid', { name: 'node_id', primary: true })
  nodeId: string;

  @Column('uuid', { name: 'release_id' })
  releaseId: string;

  @Column('int')
  epoch: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Append-only control switch history (superseded audit). Never updated. */
@Entity('control_switches')
@Unique(['nodeId', 'toEpoch'])
export class ControlSwitchEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'node_id' })
  @Index()
  nodeId: string;

  @Column('uuid', { name: 'from_release_id', nullable: true })
  fromReleaseId: string | null;

  @Column('uuid', { name: 'to_release_id' })
  toReleaseId: string;

  @Column('int', { name: 'from_epoch' })
  fromEpoch: number;

  @Column('int', { name: 'to_epoch' })
  toEpoch: number;

  /** 'schedule' | 'emergency_takeover' */
  @Column()
  reason: string;

  @Column({ default: 'system' })
  operator: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export type DispatchKind = 'deploy' | 'rollback' | 'restore';
export type DispatchStatus = 'in_flight' | 'completed' | 'timed_out' | 'orphaned';

/** Persisted in-flight request so restarts can reconcile unfinished work. */
@Entity('dispatch_requests')
export class DispatchRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'release_id' })
  @Index()
  releaseId: string;

  @Column('uuid', { name: 'task_id' })
  taskId: string;

  @Column('uuid', { name: 'node_id' })
  nodeId: string;

  @Column('int')
  epoch: number;

  @Column({ default: 'deploy' })
  kind: DispatchKind;

  @Column({ default: 'in_flight' })
  status: DispatchStatus;

  @Column('uuid', { name: 'cert_id' })
  certId: string;

  @Column({ name: 'dispatched_at', type: 'timestamptz' })
  dispatchedAt: Date;

  @Column({ name: 'deadline_at', type: 'timestamptz' })
  deadlineAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ nullable: true })
  outcome: string | null;
}

/** Append-only receipt audit, including late/superseded receipts. */
@Entity('receipts')
export class ReceiptEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'request_id' })
  @Index()
  requestId: string;

  @Column('uuid', { name: 'release_id', nullable: true })
  @Index()
  releaseId: string | null;

  @Column('uuid', { name: 'node_id', nullable: true })
  @Index()
  nodeId: string | null;

  @Column('int', { nullable: true })
  epoch: number | null;

  @Column()
  outcome: string;

  /** true when the receipt was authoritative and mutated platform state */
  @Column({ default: false })
  applied: boolean;

  /** true when the receipt arrived after timeout / loss of control */
  @Column({ default: false })
  late: boolean;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'cert_version', type: 'int', nullable: true })
  certVersion: number | null;

  @Column('jsonb', { nullable: true })
  payload: any;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
