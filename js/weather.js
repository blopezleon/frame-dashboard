/* Weather card on the Today tab. Open-Meteo needs no API key and allows
   browser requests, so the frame calls it directly. */
(function () {
  'use strict';

  var FD = window.FD;
  var CFG = (window.FD_CONFIG && window.FD_CONFIG.weather) || { lat: 29.6516, lon: -82.3248, place: '' };
  var RELOAD_MS = 15 * 60 * 1000;

  var URL = 'https://api.open-meteo.com/v1/forecast?' + FD.encodeForm({
    latitude: CFG.lat,
    longitude: CFG.lon,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: 7
  });

  /* ---------- Icons (inline SVG, 64x64) ---------- */

  var SUN_RAYS = (function () {
    var out = '';
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      out += '<line x1="' + (32 + 18 * Math.cos(a)).toFixed(1) + '" y1="' + (32 + 18 * Math.sin(a)).toFixed(1) +
        '" x2="' + (32 + 25 * Math.cos(a)).toFixed(1) + '" y2="' + (32 + 25 * Math.sin(a)).toFixed(1) + '"/>';
    }
    return out;
  })();

  var SUN = '<g stroke="#fdb813" stroke-width="4" stroke-linecap="round">' + SUN_RAYS + '</g>' +
    '<circle cx="32" cy="32" r="12" fill="#fdb813"/>';
  var MOON = '<path d="M38 10a22 22 0 1 0 16 36A18 18 0 0 1 38 10z" fill="#d6dbe8"/>';
  var CLOUD = '<path d="M19 50h28a11 11 0 0 0 1-21.9A15 15 0 0 0 19.4 25 12.5 12.5 0 0 0 19 50z" fill="#d7dce6"/>';
  var CLOUD_DARK = '<path d="M19 50h28a11 11 0 0 0 1-21.9A15 15 0 0 0 19.4 25 12.5 12.5 0 0 0 19 50z" fill="#9aa3b5"/>';

  function small(inner, x, y, scale) {
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' + inner + '</g>';
  }
  function up(inner) { return '<g transform="translate(0 -8)">' + inner + '</g>'; }

  var ICONS = {
    clear: function (day) { return day ? SUN : MOON; },
    partly: function (day) { return small(day ? SUN : MOON, -4, -6, 0.75) + small(CLOUD, 8, 10, 0.85); },
    cloudy: function () { return small(CLOUD_DARK, 10, -6, 0.8) + small(CLOUD, 0, 6, 0.9); },
    fog: function () {
      return up(CLOUD) + '<g stroke="#9aa3b5" stroke-width="4" stroke-linecap="round">' +
        '<line x1="12" y1="50" x2="52" y2="50"/><line x1="18" y1="58" x2="46" y2="58"/></g>';
    },
    rain: function () {
      return up(CLOUD) + '<g stroke="#4fa3ff" stroke-width="4" stroke-linecap="round">' +
        '<line x1="22" y1="48" x2="19" y2="57"/><line x1="33" y1="48" x2="30" y2="57"/><line x1="44" y1="48" x2="41" y2="57"/></g>';
    },
    storm: function () {
      return up(CLOUD_DARK) + '<polygon points="34,40 24,54 31,54 27,64 42,48 34,48 38,40" fill="#fdb813"/>';
    },
    snow: function () {
      return up(CLOUD) + '<g fill="#ffffff"><circle cx="22" cy="52" r="3"/><circle cx="33" cy="57" r="3"/><circle cx="44" cy="52" r="3"/></g>';
    }
  };

  // WMO weather codes → [icon, description]
  function describe(code) {
    if (code === 0) return ['clear', 'Clear'];
    if (code === 1) return ['clear', 'Mostly clear'];
    if (code === 2) return ['partly', 'Partly cloudy'];
    if (code === 3) return ['cloudy', 'Cloudy'];
    if (code === 45 || code === 48) return ['fog', 'Fog'];
    if (code >= 51 && code <= 57) return ['rain', 'Drizzle'];
    if (code >= 61 && code <= 67) return ['rain', code >= 65 ? 'Heavy rain' : 'Rain'];
    if (code >= 71 && code <= 77) return ['snow', 'Snow'];
    if (code >= 80 && code <= 82) return ['rain', 'Showers'];
    if (code === 85 || code === 86) return ['snow', 'Snow showers'];
    if (code >= 95) return ['storm', 'Thunderstorms'];
    return ['cloudy', ''];
  }

  FD.wxIcon = function (code, isDay, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 64 64">' + ICONS[describe(code)[0]](isDay !== 0 && isDay !== false) + '</svg>';
  };

  /* ---------- Data ---------- */

  // Open-Meteo local times look like "2026-09-27T22:00" (no offset).
  function parseLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
    if (!m) return new Date(NaN);
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }

  function hourLabel(d) {
    var h = d.getHours();
    return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
  }

  function deg(v) { return Math.round(v) + '°'; }

  function load() {
    FD.request({ url: URL, timeout: 20000 }, function (err, status, data) {
      if (!err && data && data.current) {
        FD.store.set('wx.data', data);
        FD.store.set('wx.ok', Date.now());
      }
      render();
    });
  }

  function render() {
    var data = FD.store.get('wx.data');
    var el = FD.$('wx');
    if (!data || !data.current) {
      el.innerHTML = '<div class="empty">Loading weather…</div>';
      return;
    }
    var cur = data.current, daily = data.daily, hourly = data.hourly;
    var d = describe(cur.weather_code);

    var html = '<div class="wx-now">' + FD.wxIcon(cur.weather_code, cur.is_day, 'wx-icon') +
      '<div><div class="wx-temp">' + deg(cur.temperature_2m) + '</div>' +
      '<div class="wx-cond">' + FD.esc(d[1]) + '</div></div></div>';

    if (daily && daily.time && daily.time.length) {
      html += '<div class="wx-meta">H ' + deg(daily.temperature_2m_max[0]) + ' · L ' + deg(daily.temperature_2m_min[0]) +
        ' · Feels ' + deg(cur.apparent_temperature) + '</div>' +
        '<div class="wx-meta">Rain ' + (daily.precipitation_probability_max[0] || 0) + '% · Wind ' +
        Math.round(cur.wind_speed_10m) + ' mph</div>';
    }

    // Next 6 hours
    if (hourly && hourly.time) {
      var now = Date.now(), cells = '';
      for (var i = 0, n = 0; i < hourly.time.length && n < 6; i++) {
        var t = parseLocal(hourly.time[i]);
        if (t.getTime() <= now) continue;
        cells += '<div class="wx-h"><span>' + hourLabel(t) + '</span>' +
          FD.wxIcon(hourly.weather_code[i], hourly.is_day[i]) +
          '<b>' + deg(hourly.temperature_2m[i]) + '</b>' +
          '<i>' + (hourly.precipitation_probability[i] || 0) + '%</i></div>';
        n++;
      }
      html += '<div class="wx-hours">' + cells + '</div>';
    }

    // Next days
    if (daily && daily.time) {
      var rows = '';
      for (var j = 1; j < daily.time.length && j <= 5; j++) {
        var day = parseLocal(daily.time[j]);
        rows += '<div class="wx-d"><span class="wx-dn">' + (j === 1 ? 'Tmrw' : FD.DAYS[day.getDay()].slice(0, 3)) + '</span>' +
          FD.wxIcon(daily.weather_code[j], 1) +
          '<span class="wx-dp">' + (daily.precipitation_probability_max[j] || 0) + '%</span>' +
          '<span class="wx-dt"><b>' + deg(daily.temperature_2m_max[j]) + '</b> ' + deg(daily.temperature_2m_min[j]) + '</span></div>';
      }
      html += '<div class="wx-days">' + rows + '</div>';
    }

    if (CFG.place) html += '<div class="wx-place">' + FD.esc(CFG.place) + '</div>';
    el.innerHTML = html;
  }

  FD.weather = {
    init: function () {
      render();
      load();
      setInterval(load, RELOAD_MS);
      setInterval(render, 5 * 60 * 1000);  // roll the hourly strip forward between loads
    }
  };
})();
