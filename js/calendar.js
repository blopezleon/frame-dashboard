/* Today and Week tabs. Events (and Canvas due dates) come from a Google
   Apps Script web app (see apps-script/Code.gs) loaded via JSONP, which
   avoids CORS entirely. The script URL is passed to the page once as
   ?cal=... and kept in localStorage, so it never lives in this public repo. */
(function () {
  'use strict';

  var FD = window.FD;
  var RELOAD_MS = 5 * 60 * 1000;
  var DAYS_AHEAD = 15;
  var HOUR = 3600000;
  var cbSeq = 0;
  var lastOk = FD.store.get('cal.ok');
  var offline = false;
  var weekOffset = 0;   // 0 = starting today, 7 = the week after
  var reg = [];         // tappable items; elements carry data-ev="<index>"

  /* ---------- Loading ---------- */

  function load() {
    var cfg = FD.store.get('cfg') || {};
    if (!cfg.cal) {
      FD.$('cal-today').innerHTML = '<div class="empty">Calendar isn\'t connected yet.</div>';
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
    function fail() { if (!done) { finish(); offline = true; renderAll(); } }

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
      renderAll();
    };
    script.onerror = fail;
    setTimeout(fail, 20000);

    script.src = cfg.cal + (cfg.cal.indexOf('?') < 0 ? '?' : '&') +
      'callback=' + name + '&days=' + DAYS_AHEAD + '&_=' + Date.now();
    document.body.appendChild(script);
  }

  function setStatus(text) { FD.$('cal-status').textContent = text; }

  /* ---------- Helpers ---------- */

  function overlaps(ev, from, to) { return ev.s < to && ev.e > from; }

  function byStart(a, b) {
    if (a.a !== b.a) return a.a ? -1 : 1;  // all-day first
    return a.s - b.s;
  }

  function track(obj) { reg.push(obj); return reg.length - 1; }

  function colorOf(ev) { return FD.esc(ev.col || '#4f8cff'); }

  function untilLabel(ms) {
    var min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return 'in ' + min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  // "Today", "Tomorrow", or "Wed, Oct 1"
  function dayName(ms) {
    if (ms >= FD.dayStart(0) && ms < FD.dayStart(1)) return 'Today';
    if (ms >= FD.dayStart(1) && ms < FD.dayStart(2)) return 'Tomorrow';
    return FD.fmtShortDate(new Date(ms));
  }

  function timeRange(ev) {
    return FD.fmtTime(new Date(ev.s)) + ' – ' + FD.fmtTime(new Date(ev.e));
  }

  function subLine(parts) {
    return parts.filter(function (s) { return s && String(s).trim(); }).map(FD.esc).join(' · ');
  }

  // Calendar descriptions can contain HTML. DOMParser doesn't run scripts or
  // load images, so it's a safe way to get plain text out.
  function toText(html) {
    if (!html) return '';
    var s = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n');
    try {
      var doc = new DOMParser().parseFromString(s, 'text/html');
      s = doc.body ? doc.body.textContent : s.replace(/<[^>]+>/g, '');
    } catch (e) { s = s.replace(/<[^>]+>/g, ''); }
    return s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  }

  function dueRow(d) {
    return '<div class="due-main"><div class="due-title">' + FD.esc(d.t) + '</div>' +
      '<div class="due-course">' + FD.esc(d.course || '') + '</div></div>' +
      '<div class="due-time">' + FD.fmtTime(new Date(d.s)) + '</div>';
  }

  /* ---------- Today tab ---------- */

  function evCard(ev, dayFrom, cls, badge) {
    var time = ev.a ? 'All day' :
      (ev.s < dayFrom ? 'Cont.' : FD.fmtTime(new Date(ev.s))) + '<small>' + FD.fmtTime(new Date(ev.e)) + '</small>';
    var sub = subLine([ev.c, ev.l]);
    return '<div class="ev ' + (cls || '') + '" data-ev="' + track(ev) + '" style="border-left-color:' + colorOf(ev) + '">' +
      '<div class="ev-time">' + time + '</div>' +
      '<div class="ev-main"><div class="ev-title">' + FD.esc(ev.t || '(No title)') + '</div>' +
      (sub ? '<div class="ev-sub">' + sub + '</div>' : '') + '</div>' +
      (badge ? '<div class="ev-badge">' + badge + '</div>' : '') +
      '</div>';
  }

  function renderUpNext(events, now) {
    var timed = events.filter(function (ev) { return !ev.a && ev.e > now; }).sort(byStart);
    var next = timed.filter(function (ev) { return ev.s <= now; })[0] || timed[0];
    if (!next) {
      FD.$('upnext').innerHTML = '<div class="upnext upnext-empty">Nothing else on the calendar.</div>';
      return null;
    }
    var live = next.s <= now;
    var badge;
    if (live) badge = 'ends ' + untilLabel(next.e - now);
    else if (next.s - now < 12 * HOUR) badge = untilLabel(next.s - now);
    else badge = dayName(next.s);
    var when = (next.s >= FD.dayStart(1) ? dayName(next.s) + ' · ' : '') + timeRange(next);

    FD.$('upnext').innerHTML =
      '<div class="upnext' + (live ? ' live' : '') + '" data-ev="' + track(next) + '" style="border-left-color:' + colorOf(next) + '">' +
      '<div class="un-top"><span class="un-label">' + (live ? 'Happening now' : 'Up next') + '</span>' +
      '<span class="un-badge">' + FD.esc(badge) + '</span></div>' +
      '<div class="un-title">' + FD.esc(next.t || '(No title)') + '</div>' +
      '<div class="un-when">' + subLine([when, next.l]) + '</div></div>';
    return next;
  }

  function renderTodayList(events, now, hero) {
    var t0 = FD.dayStart(0), t1 = FD.dayStart(1), t2 = FD.dayStart(2);
    var today = events.filter(function (ev) { return ev !== hero && overlaps(ev, t0, t1); }).sort(byStart);
    var html = today.map(function (ev) {
      if (ev.a) return evCard(ev, t0);
      if (ev.e <= now) return evCard(ev, t0, 'past');
      if (ev.s <= now) return evCard(ev, t0, 'now', 'Now');
      return evCard(ev, t0, '', untilLabel(ev.s - now));
    }).join('');
    if (!html) html = '<div class="empty small">Nothing else today.</div>';

    var tomorrow = events.filter(function (ev) {
      return ev !== hero && overlaps(ev, t1, t2) && !overlaps(ev, t0, t1);
    }).sort(byStart);
    if (tomorrow.length) {
      html += '<div class="day-head">Tomorrow</div>' +
        tomorrow.map(function (ev) { return evCard(ev, t1, 'compact'); }).join('');
    }
    FD.$('cal-today').innerHTML = html;
  }

  function renderDue(data, now) {
    var list = FD.$('due-list');
    if (!data.canvas) {
      FD.$('due-count').textContent = '';
      list.innerHTML = '<div class="empty small">Canvas isn\'t connected yet.</div>';
      return;
    }
    var due = (data.due || []).filter(function (d) { return d.s > now; })
      .sort(function (a, b) { return a.s - b.s; });
    FD.$('due-count').textContent = due.length ? due.length : '';
    if (!due.length) {
      list.innerHTML = '<div class="empty small">Nothing due. Nice.</div>';
      return;
    }
    var html = '', lastDay = '';
    due.forEach(function (d) {
      var day = dayName(d.s);
      if (day !== lastDay) { html += '<div class="day-head">' + day + '</div>'; lastDay = day; }
      var left = d.s - now;
      var cls = left < 6 * HOUR ? 'urgent' : (left < 24 * HOUR ? 'soon' : '');
      d.kind = 'due';
      html += '<div class="due ' + cls + '" data-ev="' + track(d) + '">' + dueRow(d) + '</div>';
    });
    list.innerHTML = html;
  }

  /* ---------- Week tab ---------- */

  // Assign side-by-side columns to overlapping events within one day.
  function layoutDay(evs) {
    var out = [], cluster = [], cols = [], clusterEnd = 0;
    function flush() {
      cluster.forEach(function (it) { it.n = cols.length; });
      cluster = []; cols = []; clusterEnd = 0;
    }
    evs.forEach(function (ev) {
      if (cluster.length && ev.s >= clusterEnd) flush();
      var c = 0;
      while (c < cols.length && cols[c] > ev.s) c++;
      cols[c] = ev.e;
      var it = { ev: ev, col: c };
      cluster.push(it);
      out.push(it);
      clusterEnd = Math.max(clusterEnd, ev.e);
    });
    flush();
    return out;
  }

  function hourName(h) {
    return h === 0 || h === 24 ? '12 AM' : (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
  }

  function renderWeek(data) {
    var box = FD.$('week');
    var height = box.clientHeight;
    if (!height) return;  // tab hidden; rendered again when shown

    var events = data.events || [];
    var due = data.due || [];
    var now = Date.now();
    var days = [];
    for (var i = 0; i < 7; i++) {
      days.push((function (from, to) {
        return {
          from: from,
          to: to,
          allDay: events.filter(function (ev) { return ev.a && overlaps(ev, from, to); }),
          due: due.filter(function (d) { return d.s >= from && d.s < to; }),
          timed: events.filter(function (ev) { return !ev.a && overlaps(ev, from, to); }).map(function (ev) {
            return { src: ev, s: Math.max(ev.s, from), e: Math.min(ev.e, to) };
          }).sort(function (a, b) { return a.s - b.s || b.e - a.e; })
        };
      })(FD.dayStart(weekOffset + i), FD.dayStart(weekOffset + i + 1)));
    }

    // Hour range: 8 AM–10 PM, stretched to fit anything outside it.
    var startH = 8, endH = 22;
    days.forEach(function (d) {
      d.timed.forEach(function (t) {
        var s = new Date(t.s), e = new Date(t.e);
        startH = Math.min(startH, s.getHours());
        endH = Math.max(endH, t.e >= d.to ? 24 : e.getHours() + (e.getMinutes() ? 1 : 0));
      });
    });

    var MAX_CHIPS = 3;
    var chipRows = 0;
    days.forEach(function (d) { chipRows = Math.max(chipRows, Math.min(MAX_CHIPS, d.allDay.length + d.due.length)); });
    var headH = 58, allDayH = chipRows ? chipRows * 30 + 8 : 0;
    var pph = (height - headH - allDayH - 8) / (endH - startH);

    var first = new Date(days[0].from), last = new Date(days[6].from);
    FD.$('wk-range').textContent = FD.MONTHS[first.getMonth()].slice(0, 3) + ' ' + first.getDate() + ' – ' +
      FD.MONTHS[last.getMonth()].slice(0, 3) + ' ' + last.getDate();
    FD.$('wk-prev').disabled = weekOffset === 0;
    FD.$('wk-next').disabled = weekOffset >= 7;

    var html = '<div class="wk-head" style="height:' + headH + 'px"><div class="wk-gutter"></div>';
    days.forEach(function (d, i) {
      var dt = new Date(d.from);
      var isToday = weekOffset === 0 && i === 0;
      html += '<div class="wk-dh' + (isToday ? ' today' : '') + '"><span>' +
        (isToday ? 'Today' : FD.DAYS[dt.getDay()].slice(0, 3)) + '</span><b>' + dt.getDate() + '</b></div>';
    });
    html += '</div>';

    if (allDayH) {
      html += '<div class="wk-allday" style="height:' + allDayH + 'px"><div class="wk-gutter"></div>';
      days.forEach(function (d, i) {
        var chips = d.allDay.map(function (ev) {
          return '<div class="wk-chip" data-ev="' + track(ev) + '" style="background:' + colorOf(ev) + '">' + FD.esc(ev.t) + '</div>';
        }).concat(d.due.map(function (x) {
          x.kind = 'due';
          return '<div class="wk-chip due-chip" data-ev="' + track(x) + '">Due: ' + FD.esc(x.t) + '</div>';
        }));
        if (chips.length > MAX_CHIPS) {
          chips = chips.slice(0, MAX_CHIPS - 1).concat('<div class="wk-chip more" data-day="' + i + '">+' +
            (chips.length - MAX_CHIPS + 1) + ' more</div>');
        }
        html += '<div class="wk-cell">' + chips.join('') + '</div>';
      });
      html += '</div>';
    }

    html += '<div class="wk-body"><div class="wk-gutter wk-hours">';
    for (var h = startH; h < endH; h++) {
      html += '<div class="wk-hl" style="top:' + ((h - startH) * pph) + 'px">' + hourName(h) + '</div>';
    }
    html += '</div>';

    var gridStyle = 'background-size:100% ' + pph + 'px;height:' + ((endH - startH) * pph) + 'px';
    days.forEach(function (d, i) {
      var isToday = weekOffset === 0 && i === 0;
      html += '<div class="wk-col' + (isToday ? ' today' : '') + '" style="' + gridStyle + '">';
      var base = d.from + startH * HOUR;
      layoutDay(d.timed).forEach(function (it) {
        var top = (it.ev.s - base) / HOUR * pph;
        var hgt = Math.max(22, (it.ev.e - it.ev.s) / HOUR * pph - 2);
        var w = 100 / it.n;
        var ev = it.ev.src;
        html += '<div class="wk-ev' + (ev.e <= now ? ' past' : '') + '" data-ev="' + track(ev) + '" style="top:' + top +
          'px;height:' + hgt + 'px;left:' + (it.col * w) + '%;width:' + w + '%;background:' + colorOf(ev) + '">' +
          '<b>' + FD.esc(ev.t || '(No title)') + '</b>' +
          (hgt > 40 ? '<span>' + FD.fmtTime(new Date(ev.s)) + (ev.l ? ' · ' + FD.esc(ev.l) : '') + '</span>' : '') +
          '</div>';
      });
      if (isToday && now > base && now < base + (endH - startH) * HOUR) {
        html += '<div class="wk-now" style="top:' + ((now - base) / HOUR * pph) + 'px"></div>';
      }
      html += '</div>';
    });
    html += '</div>';

    box.innerHTML = html;
  }

  /* ---------- Details sheet ---------- */

  function row(label, value) {
    return value ? '<div class="det-row"><span>' + label + '</span><div>' + value + '</div></div>' : '';
  }

  function openDetails(item) {
    var html = '<div class="det">';
    if (item.kind === 'due') {
      html += row('Due', FD.esc(FD.fmtDate(new Date(item.s)) + ' at ' + FD.fmtTime(new Date(item.s)))) +
        row('Course', FD.esc(item.courseFull || item.course));
    } else {
      var multiDay = item.e - item.s > 36 * HOUR;
      var when = item.a
        ? FD.fmtDate(new Date(item.s)) + (multiDay ? ' – ' + FD.fmtDate(new Date(item.e - 1)) : '') + ' · All day'
        : FD.fmtDate(new Date(item.s)) + ' · ' + timeRange(item);
      html += row('When', FD.esc(when)) + row('Where', FD.esc(item.l)) + row('Calendar', FD.esc(item.c));
    }
    var notes = toText(item.d);
    if (notes) html += '<div class="det-notes">' + FD.esc(notes) + '</div>';
    html += '</div>';
    FD.openSheet(item.t || '(No title)', html);
  }

  function openDay(index) {
    var data = FD.store.get('cal.data') || {};
    var from = FD.dayStart(weekOffset + index), to = FD.dayStart(weekOffset + index + 1);
    var items = (data.events || []).filter(function (ev) { return overlaps(ev, from, to); }).sort(byStart);
    var due = (data.due || []).filter(function (d) { return d.s >= from && d.s < to; });
    var html = items.map(function (ev) { return evCard(ev, from, 'compact'); }).join('') +
      due.map(function (d) {
        d.kind = 'due';
        return '<div class="due" data-ev="' + track(d) + '">' + dueRow(d) + '</div>';
      }).join('');
    FD.openSheet(FD.fmtDate(new Date(from)), html || '<div class="sheet-note">Nothing this day.</div>');
  }

  /* ---------- Render + wiring ---------- */

  function renderAll() {
    var data = FD.store.get('cal.data');
    if (!data) {
      if (offline) setStatus('Can\'t reach Google Calendar. Retrying…');
      return;
    }
    // Don't rebuild the tap registry while a details sheet is open.
    if (!FD.$('sheet').classList.contains('hidden')) return;
    reg = [];
    var now = Date.now();
    var events = data.events || [];
    var hero = renderUpNext(events, now);
    renderTodayList(events, now, hero);
    renderDue(data, now);
    if (FD.current() === 'week') renderWeek(data);

    var stamp = lastOk ? FD.fmtTime(new Date(lastOk)) : '—';
    setStatus(offline ? 'Offline · last updated ' + stamp : 'Updated ' + stamp);
  }

  function bind() {
    // One listener for every tappable event, due item, and "+N more" chip,
    // in both tabs and inside the sheet.
    document.addEventListener('click', function (e) {
      var el = FD.closestAttr(e.target, 'data-ev');
      if (el) {
        var item = reg[+el.getAttribute('data-ev')];
        if (item) openDetails(item);
        return;
      }
      el = FD.closestAttr(e.target, 'data-day');
      if (el) openDay(+el.getAttribute('data-day'));
    });
    FD.$('wk-prev').addEventListener('click', function () { weekOffset = 0; renderAll(); });
    FD.$('wk-next').addEventListener('click', function () { weekOffset = 7; renderAll(); });
    FD.onShow(function (name) { if (name === 'week' || name === 'cal') renderAll(); });
  }

  FD.calendar = {
    init: function () {
      bind();
      renderAll();
      load();
      setInterval(load, RELOAD_MS);
      setInterval(renderAll, 30 * 1000);  // keep countdowns and the "now" line fresh
    },
    reload: load
  };
})();
