/* Calendar tab. Events come from a Google Apps Script web app (see
   apps-script/Code.gs) loaded via JSONP, which avoids CORS entirely.
   The script URL is passed to the page once as ?cal=... and kept in
   localStorage, so it never lives in this public repo. */
(function () {
  'use strict';

  var FD = window.FD;
  var RELOAD_MS = 5 * 60 * 1000;
  var DAYS_AHEAD = 14;
  var cbSeq = 0;
  var lastOk = FD.store.get('cal.ok');
  var offline = false;

  function load() {
    var cfg = FD.store.get('cfg') || {};
    if (!cfg.cal) {
      FD.$('cal-today').innerHTML = '<div class="empty">Calendar isn\'t connected yet.</div>';
      FD.$('cal-upcoming').innerHTML = '';
      return;
    }

    var name = '__fdCal' + (++cbSeq);
    var script = document.createElement('script');
    var done = false;

    function finish() {
      done = true;
      window[name] = function () {};  // swallow a late response
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[name] = function (data) {
      finish();
      if (!data || data.error) {
        setStatus('Calendar error: ' + ((data && data.error) || 'empty response'));
        return;
      }
      FD.store.set('cal.data', data);
      offline = false;
      lastOk = Date.now();
      FD.store.set('cal.ok', lastOk);
      render();
    };
    function fail() { if (!done) { finish(); offline = true; render(); } }
    script.onerror = fail;
    setTimeout(fail, 20000);

    script.src = cfg.cal + (cfg.cal.indexOf('?') < 0 ? '?' : '&') +
      'callback=' + name + '&days=' + DAYS_AHEAD + '&_=' + Date.now();
    document.body.appendChild(script);
  }

  function setStatus(text) { FD.$('cal-status').textContent = text; }

  function overlaps(ev, from, to) { return ev.s < to && ev.e > from; }

  function byStart(a, b) {
    if (a.a !== b.a) return a.a ? -1 : 1;  // all-day first
    return a.s - b.s;
  }

  function timeLabel(ev, dayFrom) {
    if (ev.a) return 'All day';
    var start = ev.s < dayFrom ? 'Cont.' : FD.fmtTime(new Date(ev.s));
    return start + '<small>' + FD.fmtTime(new Date(ev.e)) + '</small>';
  }

  function untilLabel(ms) {
    var min = Math.round(ms / 60000);
    if (min < 60) return 'in ' + min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function card(ev, dayFrom, extraClass, badge) {
    var sub = [ev.c, ev.l].filter(function (s) { return s && String(s).trim(); }).join(' · ');
    return '<div class="ev ' + (extraClass || '') + '" style="border-left-color:' + FD.esc(ev.col || '#4f8cff') + '">' +
      '<div class="ev-time">' + timeLabel(ev, dayFrom) + '</div>' +
      '<div class="ev-main"><div class="ev-title">' + FD.esc(ev.t || '(No title)') + '</div>' +
      (sub ? '<div class="ev-sub">' + FD.esc(sub) + '</div>' : '') + '</div>' +
      (badge ? '<div class="ev-badge">' + badge + '</div>' : '') +
      '</div>';
  }

  function render() {
    var data = FD.store.get('cal.data');
    if (!data) {
      if (offline) setStatus('Can\'t reach Google Calendar. Retrying…');
      return;
    }
    var events = data.events || [];
    var now = Date.now();
    var today0 = FD.dayStart(0), today1 = FD.dayStart(1);

    // Today
    var today = events.filter(function (ev) { return overlaps(ev, today0, today1); }).sort(byStart);
    var nextFound = false;
    var html = today.map(function (ev) {
      if (ev.a) return card(ev, today0);
      if (ev.e <= now) return card(ev, today0, 'past');
      if (ev.s <= now) return card(ev, today0, 'now', 'Now');
      if (!nextFound) { nextFound = true; return card(ev, today0, '', untilLabel(ev.s - now)); }
      return card(ev, today0);
    }).join('');
    FD.$('cal-today').innerHTML = html || '<div class="empty">Nothing on the calendar today.</div>';

    // Coming up: each event once, under the first future day it touches
    var shown = {};
    today.forEach(function (ev) { shown[ev.s + '|' + ev.t] = true; });
    var up = '';
    for (var i = 1; i < DAYS_AHEAD; i++) {
      var from = FD.dayStart(i), to = FD.dayStart(i + 1);
      var dayEvents = events.filter(function (ev) {
        var key = ev.s + '|' + ev.t;
        if (shown[key] || !overlaps(ev, from, to)) return false;
        shown[key] = true;
        return true;
      }).sort(byStart);
      if (!dayEvents.length) continue;
      var label = i === 1 ? 'Tomorrow' : FD.fmtShortDate(new Date(from));
      up += '<div class="day-head">' + label + '</div>' +
        dayEvents.map(function (ev) { return card(ev, from); }).join('');
    }
    FD.$('cal-upcoming').innerHTML = up || '<div class="empty">Nothing in the next two weeks.</div>';

    var stamp = lastOk ? FD.fmtTime(new Date(lastOk)) : '—';
    setStatus(offline ? 'Offline · last updated ' + stamp : 'Updated ' + stamp);
  }

  FD.calendar = {
    init: function () {
      render();
      load();
      setInterval(load, RELOAD_MS);
      setInterval(render, 60 * 1000);  // keep "now"/"in 5 min" fresh
    },
    reload: load
  };
})();
