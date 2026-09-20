import { Injectable } from '@nestjs/common';

/** Mutable runtime settings, populated once the HTTP listener is up. */
@Injectable()
export class RuntimeConfig {
  /** where the node simulator lives */
  simulatorUrl = process.env.SIMULATOR_URL || 'http://127.0.0.1:4100';
  /** public base url of this API, used as receipt callback target */
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000';
  sweepIntervalMs = Number(process.env.SWEEP_INTERVAL_MS || 200);
  recoveryEnabled = process.env.DISABLE_RECOVERY !== '1';
}
