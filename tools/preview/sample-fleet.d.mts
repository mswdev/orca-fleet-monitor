// Types for sample-fleet.mjs, the invented fleet the preview and the listing images show.
import type { FleetSnapshot, FleetThresholds } from '../../src/model.ts'

/** The thresholds the sample is judged on: the defaults Fleet Monitor ships with. */
export const SAMPLE_THRESHOLDS: FleetThresholds

/** A `fleet.snapshot` answer for a preview state. */
export function sampleSnapshot(
  state?: 'live' | 'empty' | 'connecting',
  now?: number,
  thresholds?: FleetThresholds
): FleetSnapshot
