// Pure rules for job sharing (P2P). No Firebase calls here, so it is tested offline.
// Times: Western Australia has no daylight saving, so Perth = UTC+8 all year.
//
// Pay week: Monday to Sunday. Timesheet cut-off: 10:00 Perth the FOLLOWING Monday.
// A job is offered while now is before the cut-off of the pay week containing its END date.
// Pool rows are deleted 14 days after the job's end date.
// Phone registrations are deleted after 60 days without the app opening.

const DAY = 86400000;
const PERTH_OFFSET_H = 8;
const POOL_KEEP_DAYS = 14;
const DEVICE_IDLE_DAYS = 60;

function isoToUtcMs(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function msToIso(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Monday (ISO date) of the pay week that contains the given ISO date.
function payWeekMonday(iso) {
  const ms = isoToUtcMs(iso);
  const dow = new Date(ms).getUTCDay();          // 0 = Sunday .. 6 = Saturday
  const back = (dow + 6) % 7;                     // days since Monday
  return msToIso(ms - back * DAY);
}

// Submission cut-off for a job, as epoch ms: 10:00 Perth on the Monday after its pay week.
function cutoffMs(endIso) {
  const nextMonday = isoToUtcMs(payWeekMonday(endIso)) + 7 * DAY;
  return nextMonday + (10 - PERTH_OFFSET_H) * 3600000;   // 10:00 Perth = 02:00 UTC
}

// Is this job still worth offering at nowMs?
function isOfferable(job, nowMs) {
  if (!job || !job.endDate) return false;
  return nowMs < cutoffMs(job.endDate);
}

// When a pool row is deleted: start of the day 14 days after the job's end date (Perth), as epoch ms.
function poolExpiryMs(endIso) {
  return isoToUtcMs(endIso) + POOL_KEEP_DAYS * DAY - PERTH_OFFSET_H * 3600000;   // start of that day, Perth
}

// Which phone registrations to delete at nowMs.
function staleDeviceIds(devices, nowMs) {
  const limit = nowMs - DEVICE_IDLE_DAYS * DAY;
  return devices.filter(d => !d.lastOpenedMs || d.lastOpenedMs < limit).map(d => d.id);
}

// Document id for one offer: one job, one phone.
function offerId(jobNumber, installId) {
  return `${String(jobNumber).replace(/[^A-Za-z0-9_-]/g, '')}__${String(installId).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

module.exports = { payWeekMonday, cutoffMs, isOfferable, poolExpiryMs, staleDeviceIds, offerId, POOL_KEEP_DAYS, DEVICE_IDLE_DAYS };
