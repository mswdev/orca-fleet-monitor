// The 1.2 states the preview draws (activity-frame.mjs), named as the design's pictures are.
/** machine, tab, and what is done on the tab. */
export const STATES = {
  overview: { machine: 'mbp' },
  'overview-memory-critical': { machine: 'studio' },
  'overview-basic': { machine: 'ci' },
  activity: { machine: 'mbp', tab: 'activity' },
  'activity-on-battery': { machine: 'mbp', tab: 'activity', scene: 'on-battery' },
  'activity-no-gpu-battery': { machine: 'mini', tab: 'activity' },
  'activity-remote': { machine: 'studio', tab: 'activity' },
  'activity-loading': { machine: 'mbp', tab: 'activity', loading: true },
  'activity-search': { machine: 'mbp', tab: 'activity', search: 'chrome' },
  'activity-no-results': { machine: 'mbp', tab: 'activity', search: 'blendr' },
  'activity-by-memory': { machine: 'mbp', tab: 'activity', sort: 'memory' },
  'activity-by-energy': { machine: 'mbp', tab: 'activity', sort: 'energy' },
  'activity-row-open': { machine: 'mbp', tab: 'activity', open: 0 }
}
