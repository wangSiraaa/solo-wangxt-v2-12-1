import { ReleaseKind, ReleaseStrategy } from './entities';

/**
 * Compute rollout stages as lists of node ids.
 * Stage 0 is the canary stage; a normal release pauses at the gray gate
 * after stage 0. Emergency releases roll out to every node in one stage
 * (no gray gate).
 */
export function computeStages(
  nodeIds: string[],
  strategy: ReleaseStrategy,
  kind: ReleaseKind,
): string[][] {
  if (nodeIds.length === 0) return [[]];
  if (kind === 'emergency') return [[...nodeIds]];
  const canaryCount = Math.min(
    nodeIds.length,
    Math.max(1, Math.ceil((nodeIds.length * (strategy.canaryPercent || 0)) / 100)),
  );
  const stages: string[][] = [nodeIds.slice(0, canaryCount)];
  let rest = nodeIds.slice(canaryCount);
  const batch = Math.max(1, strategy.batchSize || 1);
  while (rest.length > 0) {
    stages.push(rest.slice(0, batch));
    rest = rest.slice(batch);
  }
  return stages;
}
