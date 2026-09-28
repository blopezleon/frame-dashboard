/**
 * Calendar feed for the frame dashboard.
 *
 * Setup: script.google.com → New project → paste this file → set KEY below →
 * Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 * Give the frame:  <web app URL>?key=<KEY>
 */
var KEY = 'CHANGE_ME';

// Leave empty to use every calendar that's checked in Google Calendar,
// or list calendar IDs, e.g. ['primary', 'family123@group.calendar.google.com'].
var CALENDAR_IDS = [];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = /^[A-Za-z_$][\w$]*$/.test(p.callback || '') ? p.callback : null;
  if (p.key !== KEY) return reply({ error: 'bad key' }, callback);

  var days = Math.max(1, Math.min(31, parseInt(p.days, 10) || 14));
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days + 1);

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
        l: ev.getLocation()
      });
    });
  });

  return reply({ events: events, generated: Date.now(), tz: Session.getScriptTimeZone() }, callback);
}

function reply(obj, callback) {
  var json = JSON.stringify(obj);
  return callback
    ? ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
    : ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
