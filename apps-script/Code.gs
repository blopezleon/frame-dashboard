/**
 * Calendar feed for the frame dashboard: Google Calendar events plus
 * Canvas due dates.
 *
 * Setup: script.google.com → New project → paste this file → set KEY and
 * CANVAS_FEED below → Deploy → New deployment → Web app,
 * Execute as: Me, Who has access: Anyone.
 * Updating later: Deploy → Manage deployments → ✎ → Version: New version →
 * Deploy (keeps the same URL).
 * Give the frame:  <web app URL>?key=<KEY>
 */
var KEY = 'CHANGE_ME';

// Canvas → Calendar → "Calendar Feed" (bottom right). Leave empty to skip Canvas.
var CANVAS_FEED = '';

// Rename Canvas course codes, e.g. a cross-listed course Canvas files under the grad number.
var COURSE_NAMES = { EEL6825: 'EEL4930' };

// Leave empty to use every calendar that's checked in Google Calendar,
// or list calendar IDs, e.g. ['primary', 'family123@group.calendar.google.com'].
var CALENDAR_IDS = [];

var NOTES_MAX = 1500;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = /^[A-Za-z_$][\w$]*$/.test(p.callback || '') ? p.callback : null;
  if (p.key !== KEY) return reply({ error: 'bad key' }, callback);

  var days = Math.max(1, Math.min(31, parseInt(p.days, 10) || 14));
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days + 1);

  var out = {
    events: googleEvents(start, end),
    canvas: !!CANVAS_FEED,
    due: [],
    generated: Date.now(),
    tz: Session.getScriptTimeZone()
  };
  if (CANVAS_FEED) {
    try {
      out.due = canvasDue(start.getTime(), end.getTime());
    } catch (err) {
      out.canvasError = String(err);
    }
  }
  return reply(out, callback);
}

function googleEvents(start, end) {
  var calendars = CALENDAR_IDS.length
    ? CALENDAR_IDS.map(function (id) { return CalendarApp.getCalendarById(id); }).filter(Boolean)
    : CalendarApp.getAllCalendars().filter(function (c) { return c.isSelected() && !c.isHidden(); });

  var events = [];
  calendars.forEach(function (cal) {
    cal.getEvents(start, end).forEach(function (ev) {
      if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return;  // declined
      events.push({
        t: ev.getTitle(),
        s: ev.getStartTime().getTime(),
        e: ev.getEndTime().getTime(),
        a: ev.isAllDayEvent(),
        c: cal.getName(),
        col: cal.getColor(),
        l: ev.getLocation(),
        d: (ev.getDescription() || '').slice(0, NOTES_MAX)
      });
    });
  });
  return events;
}

/* ---------- Canvas (iCalendar feed) ---------- */

function canvasDue(from, to) {
  // The raw feed is too big for the script cache (100 KB per value), so cache
  // the parsed list of upcoming assignments instead.
  var cache = CacheService.getScriptCache();
  var cached = cache.get('canvas.due');
  var all = cached ? JSON.parse(cached) : null;
  if (!all) {
    all = parseCanvas(UrlFetchApp.fetch(CANVAS_FEED).getContentText(), Date.now() - 2 * 86400000);
    var json = JSON.stringify(all);
    if (json.length < 95000) cache.put('canvas.due', json, 15 * 60);
  }
  return all.filter(function (d) { return d.s >= from && d.s < to; });
}

function parseCanvas(ics, since) {
  var due = [];
  parseIcs(ics).forEach(function (ev) {
    if (!ev.DTSTART) return;
    var s = icsTime(ev.DTSTART, ev.DTSTART_PARAMS);
    if (s === null || s < since) return;
    // Canvas marks assignments with "#assignment_<id>" in the event URL.
    if ((ev.URL || '').indexOf('assignment') < 0) return;

    var summary = (ev.SUMMARY || '').trim();
    var m = /^(.*?)\s*\[([^\]]+)\]$/.exec(summary);
    var title = (m ? m[1] : summary)
      .replace(/\s*\([A-Z]{3}\d{4}[^()]*(\([^)]*\))?[^()]*\)/g, '')  // "(EEL4930-PRRC(27197))"
      .replace(/\s+/g, ' ').trim();
    var courseFull = m ? m[2].trim() : '';
    var code = /[A-Z]{3}\s?\d{4}[A-Z]?/.exec(courseFull);
    var course = code ? code[0].replace(' ', '') : courseFull;
    due.push({
      t: title,
      s: s,
      course: COURSE_NAMES[course] || course,
      courseFull: courseFull,
      d: (ev.DESCRIPTION || '').slice(0, 600)
    });
  });
  return due;
}

// Minimal iCalendar reader: VEVENT blocks → { NAME: value, NAME_PARAMS: '...' }.
function parseIcs(text) {
  var lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  var events = [], cur = null;
  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { cur = {}; return; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; return; }
    if (!cur) return;
    var colon = line.indexOf(':');
    if (colon < 0) return;
    var head = line.slice(0, colon), value = line.slice(colon + 1);
    var semi = head.indexOf(';');
    var name = semi < 0 ? head : head.slice(0, semi);
    cur[name] = value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    if (semi >= 0) cur[name + '_PARAMS'] = head.slice(semi + 1);
  });
  return events;
}

// DTSTART values: 20260930 (all day → due end of day), 20260930T035900Z (UTC),
// or 20260930T235900 with TZID=... (local time in that zone).
function icsTime(value, params) {
  var tz = Session.getScriptTimeZone();
  var tzid = /TZID=([^;:]+)/.exec(params || '');
  if (/^\d{8}$/.test(value)) {
    return Utilities.parseDate(value + ' 235900', tz, 'yyyyMMdd HHmmss').getTime();
  }
  var m = /^(\d{8})T(\d{6})(Z?)$/.exec(value);
  if (!m) return null;
  var zone = m[3] ? 'UTC' : (tzid ? tzid[1] : tz);
  return Utilities.parseDate(m[1] + ' ' + m[2], zone, 'yyyyMMdd HHmmss').getTime();
}

function reply(obj, callback) {
  var json = JSON.stringify(obj);
  return callback
    ? ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
    : ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
