/* Shared helpers, tabs, and the clock.
   Everything here is ES5 on purpose: the frame's WebView is Chrome 44
   (no arrow functions, let/const, template strings, or URLSearchParams). */
(function () {
  'use strict';

  var FD = window.FD = window.FD || {};

  FD.$ = function (id) { return document.getElementById(id); };

  FD.store = {
    get: function (k) {
      try {
        var v = localStorage.getItem('fd.' + k);
        return v === null ? null : JSON.parse(v);
      } catch (e) { return null; }
    },
    set: function (k, v) {
      try { localStorage.setItem('fd.' + k, JSON.stringify(v)); } catch (e) {}
    },
    del: function (k) {
      try { localStorage.removeItem('fd.' + k); } catch (e) {}
    }
  };

  FD.parseQuery = function (qs) {
    var out = {};
    qs = (qs || '').replace(/^[?#]/, '');
    if (!qs) return out;
    qs.split('&').forEach(function (part) {
      var i = part.indexOf('=');
      var k = i < 0 ? part : part.slice(0, i);
      var v = i < 0 ? '' : part.slice(i + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
    });
    return out;
  };

  FD.encodeForm = function (obj) {
    return Object.keys(obj).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
    }).join('&');
  };

  // cb(err, status, data, xhr); data is parsed JSON when possible.
  FD.request = function (opts, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(opts.method || 'GET', opts.url, true);
    var headers = opts.headers || {};
    Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
    xhr.timeout = opts.timeout || 15000;
    xhr.onload = function () {
      var data = null;
      if (xhr.responseText) {
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = xhr.responseText; }
      }
      var ok = xhr.status >= 200 && xhr.status < 300;
      cb(ok ? null : new Error('HTTP ' + xhr.status), xhr.status, data, xhr);
    };
    xhr.onerror = xhr.ontimeout = function () { cb(new Error('network'), 0, null, xhr); };
    xhr.send(opts.body === undefined ? null : opts.body);
  };

  FD.esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // Walk up from el to find an ancestor with the given attribute.
  FD.closestAttr = function (el, attr) {
    while (el && el.nodeType === 1) {
      if (el.hasAttribute(attr)) return el;
      el = el.parentNode;
    }
    return null;
  };

  FD.DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  FD.MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  FD.fmtTime = function (d) {
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  };

  FD.fmtDate = function (d) {
    return FD.DAYS[d.getDay()] + ', ' + FD.MONTHS[d.getMonth()] + ' ' + d.getDate();
  };

  FD.fmtShortDate = function (d) {
    return FD.DAYS[d.getDay()].slice(0, 3) + ', ' + FD.MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
  };

  FD.fmtDuration = function (ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  // Midnight at the start of the day `offset` days from today.
  FD.dayStart = function (offset) {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offset || 0)).getTime();
  };

  var toastTimer = null;
  FD.toast = function (msg) {
    var t = FD.$('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  };

  /* ---------- Views: tap a tab or swipe sideways ---------- */

  var VIEWS = ['cal', 'week', 'music', 'ambient'];
  var current = null;
  var showHandlers = [];

  FD.onShow = function (fn) { showHandlers.push(fn); };
  FD.current = function () { return current; };

  FD.show = function (name) {
    if (VIEWS.indexOf(name) < 0) name = VIEWS[0];
    current = name;
    VIEWS.forEach(function (v) {
      FD.$('view-' + v).classList.toggle('active', v === name);
      document.querySelector('.tab[data-view="' + v + '"]').classList.toggle('active', v === name);
    });
    document.body.classList.toggle('immersive', name === 'ambient');
    FD.store.set('view', name);
    showHandlers.forEach(function (fn) { fn(name); });
  };

  function initTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { FD.show(b.getAttribute('data-view')); });
    });

    var sx = 0, sy = 0, tracking = false;
    document.addEventListener('touchstart', function (e) {
      tracking = e.touches.length === 1 &&
        !FD.closestAttr(e.target, 'data-noswipe') &&
        FD.$('sheet').classList.contains('hidden');
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    });
    document.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 140 && Math.abs(dy) < 90) {
        var i = VIEWS.indexOf(current) + (dx < 0 ? 1 : -1);
        if (i >= 0 && i < VIEWS.length) FD.show(VIEWS[i]);
      }
    });
  }

  /* ---------- Clock ---------- */

  function tickClock() {
    var d = new Date();
    var parts = FD.fmtTime(d).split(' ');
    FD.$('time').innerHTML = parts[0] + '<small>' + parts[1] + '</small>';
    FD.$('date').textContent = FD.fmtDate(d);
  }

  /* ---------- Sheet (modal list used by the Spotify pickers) ---------- */

  FD.openSheet = function (title, html) {
    FD.$('sheet-title').textContent = title;
    FD.$('sheet-body').innerHTML = html;
    FD.$('sheet-body').scrollTop = 0;
    FD.$('sheet').classList.remove('hidden');
  };
  FD.closeSheet = function () { FD.$('sheet').classList.add('hidden'); };

  FD.initCore = function () {
    initTabs();
    tickClock();
    setInterval(tickClock, 1000);
    FD.$('sheet-close').addEventListener('click', FD.closeSheet);
    FD.$('sheet').addEventListener('click', function (e) {
      if (e.target === FD.$('sheet')) FD.closeSheet();
    });
  };
})();
