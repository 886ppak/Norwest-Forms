// ===== NCH job calendar scraper (owner account only) =====
// Reads mobilisation emails from the owner's Gmail, parses the worker's own row
// with the same parser as the PWA share feature, and writes the jobs to a
// Google Calendar. Runs on an hourly time trigger. Nothing leaves the account.
//
// Script properties (Project Settings > Script properties):
//   WORKER_NAME   required, exactly as it appears on the email, e.g. "Aiden Amur"
//   SEARCH_QUERY  optional Gmail search (default below)
//   CALENDAR_NAME optional, default "NCH jobs"
//   ALERT_TO      optional, email address for the summary of each run that did something

function csConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    name: String(p.getProperty('WORKER_NAME') || '').trim(),
    query: p.getProperty('SEARCH_QUERY') ||
      'newer_than:120d (subject:mobilisation OR subject:"travel confirmation" OR subject:mobe)',
    calendarName: p.getProperty('CALENDAR_NAME') || 'NCH jobs',
    alertTo: String(p.getProperty('ALERT_TO') || '').trim(),
    doneLabel: 'nch-jobs-imported'
  };
}

// Same key the PWA uses for a job (calJobKey), so a job keeps one identity.
function csJobKey_(job) { return [job.vd, job.mob, job.first, job.last, job.shift, job.cls].join('|'); }

function csDesc_(job) {
  const lines = [];
  if (job.cls) lines.push('Class: ' + job.cls);
  if (job.commute) lines.push('Commute: ' + job.commute);
  if (job.travelIn) lines.push('Travel in: ' + job.travelIn);
  if (job.travelOut) lines.push('Travel out: ' + job.travelOut);
  if (job.accom) lines.push('Accommodation: ' + job.accom);
  if (job.sdText) lines.push('SD/FD: ' + job.sdText);
  if (job.warnings && job.warnings.length) lines.push('Check: ' + job.warnings.join('; '));
  return lines.join('\n');
}

// Pure function (no Google services): one parsed job -> calendar items.
// Dates are 'YYYY-MM-DD'; end is inclusive.
function csJobItems(job) {
  const base = csJobKey_(job);
  const where = [job.vd, job.site].filter(Boolean).join(' ');
  const items = [];
  if (job.first && job.last) {
    items.push({ key: base + '|shift', title: job.shift + ' ' + where, start: job.first, end: job.last, description: csDesc_(job) });
  }
  if (job.mob) items.push({ key: base + '|mob', title: 'MOB ' + where, start: job.mob, end: job.mob, description: '' });
  if (job.demob) items.push({ key: base + '|demob', title: 'DMOB ' + where, start: job.demob, end: job.demob, description: '' });
  if (job.sdDate) items.push({ key: base + '|sd', title: 'SD/FD ' + where, start: job.sdDate, end: job.sdDate, description: job.sdText || '' });
  return items;
}

function csDate_(iso, plusDays) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2] + (plusDays || 0));
}

function csEnsureCalendar_(name) {
  const found = CalendarApp.getCalendarsByName(name);
  if (found.length) return found[0];
  return CalendarApp.createCalendar(name, { timeZone: 'Australia/Perth' });
}

// Create missing events, update changed ones. Events are found by a tag holding the item key.
function csSync_(cal, items) {
  const result = { created: 0, updated: 0 };
  if (!items.length) return result;
  const starts = items.map(i => i.start).sort();
  const ends = items.map(i => i.end).sort();
  const from = csDate_(starts[0], -1);
  const to = csDate_(ends[ends.length - 1], 2);
  const existing = {};
  cal.getEvents(from, to).forEach(ev => {
    const k = ev.getTag('nchkey');
    if (k) existing[k] = ev;
  });
  items.forEach(it => {
    const ev = existing[it.key];
    if (ev) {
      if (ev.getTitle() !== it.title || ev.getDescription() !== it.description) {
        ev.setTitle(it.title);
        ev.setDescription(it.description);
        result.updated++;
      }
      return;
    }
    const created = cal.createAllDayEvent(it.title, csDate_(it.start), csDate_(it.end, 1), { description: it.description });
    created.setTag('nchkey', it.key);
    result.created++;
  });
  return result;
}

// Main entry point for the hourly trigger.
function scrapeJobEmails() {
  const cfg = csConfig_();
  if (!cfg.name) throw new Error('Set WORKER_NAME in Project Settings > Script properties first.');
  const label = GmailApp.getUserLabelByName(cfg.doneLabel) || GmailApp.createLabel(cfg.doneLabel);
  const threads = GmailApp.search(cfg.query + ' -label:' + cfg.doneLabel, 0, 100);
  const report = { threads: threads.length, jobs: [], skipped: [], warnings: [], created: 0, updated: 0 };
  const items = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const subject = msg.getSubject();
      const r = calParseEmail(msg.getPlainBody(), cfg.name, subject);
      if (r.error || !r.jobs) {
        report.skipped.push(subject + ' (' + String(r.error || 'no job rows').slice(0, 80) + ')');
        return;
      }
      r.jobs.forEach(job => {
        report.jobs.push((job.vd || '') + ' ' + (job.site || subject) + ' ' + job.first + ' to ' + job.last);
        job.warnings.forEach(w => report.warnings.push(subject + ': ' + w));
        csJobItems(job).forEach(it => items.push(it));
      });
    });
    thread.addLabel(label);
  });

  const cal = csEnsureCalendar_(cfg.calendarName);
  const sync = csSync_(cal, items);
  report.created = sync.created;
  report.updated = sync.updated;

  if (cfg.alertTo && (report.threads > 0)) {
    const body = [
      'Threads checked: ' + report.threads,
      'Jobs found: ' + report.jobs.length + ' (created ' + report.created + ', updated ' + report.updated + ')',
      '',
      report.jobs.length ? 'Jobs:\n  ' + report.jobs.join('\n  ') : '',
      report.warnings.length ? 'Check these:\n  ' + report.warnings.join('\n  ') : '',
      report.skipped.length ? 'Skipped:\n  ' + report.skipped.join('\n  ') : ''
    ].filter(Boolean).join('\n');
    MailApp.sendEmail(cfg.alertTo, 'NCH jobs: ' + report.created + ' new, ' + report.updated + ' updated', body);
  }
  Logger.log(JSON.stringify(report));
  return report;
}

// Run once by hand after setting WORKER_NAME. Installs the hourly trigger.
function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'scrapeJobEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scrapeJobEmails').timeBased().everyHours(1).create();
}
