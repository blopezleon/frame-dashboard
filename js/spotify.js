/* Music tab: a Spotify Connect remote. The frame can't play Spotify audio
   itself (too old), so it controls whatever device is playing.
   Login is Authorization Code + PKCE, so no client secret is needed. */
(function () {
  'use strict';

  var FD = window.FD;
  var CFG = window.FD_CONFIG || {};
  var API = 'https://api.spotify.com/v1';
  var SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative'
  ].join(' ');

  var tok = FD.store.get('sp.tok');   // { a: access, r: refresh, x: expiry ms }
  var player = null;                  // last GET /me/player response
  var polledAt = 0;
  var pollTimer = null;
  var backoffUntil = 0;
  var refreshing = null;              // queued callbacks while a refresh is in flight
  var volBusy = false;
  var shownArt = null;

  /* ---------- Auth ---------- */

  function randomString(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    var bytes = new Uint8Array(len);
    window.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < len; i++) out += chars.charAt(bytes[i] % chars.length);
    return out;
  }

  function base64url(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function challengeFor(verifier) {
    var bytes = [];
    for (var i = 0; i < verifier.length; i++) bytes.push(verifier.charCodeAt(i));
    return base64url(FD.sha256(bytes));
  }

  function login(handoff) {
    var verifier = randomString(64);
    var state = randomString(16);
    FD.store.set('sp.pkce', { v: verifier, st: state, h: !!handoff });
    location.href = 'https://accounts.spotify.com/authorize?' + FD.encodeForm({
      response_type: 'code',
      client_id: CFG.spotifyClientId,
      scope: SCOPES,
      redirect_uri: CFG.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challengeFor(verifier),
      state: state
    });
  }

  function saveToken(data) {
    tok = {
      a: data.access_token,
      r: data.refresh_token || (tok && tok.r),
      x: Date.now() + (data.expires_in || 3600) * 1000
    };
    FD.store.set('sp.tok', tok);
  }

  function tokenRequest(form, cb) {
    FD.request({
      method: 'POST',
      url: 'https://accounts.spotify.com/api/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: FD.encodeForm(form)
    }, cb);
  }

  // Finish a login if Spotify just redirected back here with ?code=...
  function handleRedirect(q) {
    if (q.error && q.state) { FD.toast('Spotify sign-in was cancelled.'); return; }
    if (!q.code || !q.state) return;
    var pk = FD.store.get('sp.pkce');
    FD.store.del('sp.pkce');
    if (!pk || pk.st !== q.state) { FD.toast('Spotify sign-in expired, try again.'); return; }

    tokenRequest({
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: CFG.redirectUri,
      client_id: CFG.spotifyClientId,
      code_verifier: pk.v
    }, function (err, status, data) {
      if (err || !data || !data.access_token) {
        FD.toast('Spotify sign-in failed (' + status + ').');
        return;
      }
      if (pk.h) {
        // Handoff mode: signed in on another computer, show the refresh token
        // so it can be moved to the frame. Don't keep it here.
        FD.$('sp-handoff').classList.remove('hidden');
        FD.$('sp-token').value = data.refresh_token;
        FD.show('music');
        return;
      }
      saveToken(data);
      FD.show('music');
      poll();
    });
  }

  function withToken(cb) {
    if (!tok || !tok.r) return cb(new Error('signed out'));
    if (tok.a && tok.x - 60000 > Date.now()) return cb(null, tok.a);
    if (refreshing) { refreshing.push(cb); return; }
    refreshing = [cb];
    tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tok.r,
      client_id: CFG.spotifyClientId
    }, function (err, status, data) {
      var waiting = refreshing;
      refreshing = null;
      if (!err && data && data.access_token) {
        saveToken(data);
        waiting.forEach(function (fn) { fn(null, tok.a); });
        return;
      }
      if (status === 400 || status === 401) signOut();  // refresh token revoked or expired
      waiting.forEach(function (fn) { fn(err || new Error('refresh failed')); });
    });
  }

  function signOut() {
    tok = null;
    player = null;
    FD.store.del('sp.tok');
    render();
  }

  /* ---------- API ---------- */

  // cb(err, status, data)
  function api(method, path, body, cb, retried) {
    cb = cb || function () {};
    if (Date.now() < backoffUntil) return cb(new Error('rate limited'), 429, null);
    withToken(function (err, access) {
      if (err) return cb(err, 0, null);
      FD.request({
        method: method,
        url: API + path,
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      }, function (e, status, data, xhr) {
        if (status === 401 && !retried) {
          tok.x = 0;
          return api(method, path, body, cb, true);
        }
        if (status === 429) {
          backoffUntil = Date.now() + (parseInt(xhr.getResponseHeader('Retry-After'), 10) || 5) * 1000;
        }
        cb(e, status, data);
      });
    });
  }

  function errorText(status, data) {
    var reason = data && data.error && (data.error.reason || data.error.message);
    if (status === 404 || reason === 'NO_ACTIVE_DEVICE') return 'No active device. Pick one first.';
    if (status === 403) return 'Spotify didn\'t allow that on this device.';
    if (status === 429) return 'Spotify says slow down. Try again in a moment.';
    return 'Spotify error' + (status ? ' (' + status + ')' : '') + '.';
  }

  // Run a player command, update the UI right away, then re-check with Spotify.
  function command(method, path, body, optimistic) {
    if (optimistic && player) { optimistic(player); render(); }
    api(method, path, body, function (err, status, data) {
      if (err) {
        FD.toast(errorText(status, data));
        if (status === 404) openDevices();
      }
      setTimeout(poll, 700);
    });
  }

  /* ---------- Polling ---------- */

  function poll() {
    clearTimeout(pollTimer);
    if (!tok) { render(); return; }
    api('GET', '/me/player?additional_types=episode', null, function (err, status, data) {
      if (status === 204 || (!err && !data)) player = null;
      else if (!err) player = data;
      polledAt = Date.now();
      if (player && player.device) FD.store.set('sp.lastDevice', player.device.id);
      render();
      schedule();
    });
  }

  function schedule() {
    clearTimeout(pollTimer);
    var fast = FD.current() === 'music';
    pollTimer = setTimeout(poll, fast ? 3000 : 15000);
  }

  /* ---------- Rendering ---------- */

  function trackInfo(item) {
    if (!item) return null;
    if (item.type === 'episode') {
      return {
        title: item.name,
        artist: item.show ? item.show.name : '',
        album: 'Podcast',
        art: item.images && item.images[0] ? item.images[0].url : ''
      };
    }
    var imgs = item.album && item.album.images ? item.album.images : [];
    return {
      title: item.name,
      artist: (item.artists || []).map(function (a) { return a.name; }).join(', '),
      album: item.album ? item.album.name : '',
      art: imgs[0] ? imgs[0].url : '',
      thumb: imgs.length ? imgs[imgs.length - 1].url : ''
    };
  }

  function setArt(url) {
    if (url === shownArt) return;
    shownArt = url;
    FD.$('np-art').src = url || '';
    FD.$('np-bg').src = url || '';
    FD.$('np-art').style.visibility = url ? 'visible' : 'hidden';
    FD.$('np-bg').style.visibility = url ? 'visible' : 'hidden';
  }

  function progressNow() {
    if (!player || !player.item) return 0;
    var p = player.progress_ms || 0;
    if (player.is_playing) p += Date.now() - polledAt;
    return Math.min(p, player.item.duration_ms || 0);
  }

  function renderProgress() {
    if (!player || !player.item) {
      FD.$('np-fill').style.width = '0';
      FD.$('np-pos').textContent = '0:00';
      FD.$('np-dur').textContent = '0:00';
      return;
    }
    var dur = player.item.duration_ms || 1;
    var pos = progressNow();
    FD.$('np-fill').style.width = (pos / dur * 100) + '%';
    FD.$('np-pos').textContent = FD.fmtDuration(pos);
    FD.$('np-dur').textContent = FD.fmtDuration(dur);
    // Track probably changed; don't wait for the next scheduled poll.
    if (player.is_playing && pos >= dur && Date.now() - polledAt > 1500) poll();
  }

  function render() {
    var signedIn = !!tok;
    FD.$('sp-connect').classList.toggle('hidden', signedIn);
    FD.$('sp-player').classList.toggle('hidden', !signedIn);
    if (!signedIn) {
      var configured = !!CFG.spotifyClientId;
      FD.$('sp-login').classList.toggle('hidden', !configured);
      FD.$('sp-connect-msg').textContent = configured
        ? 'Sign in once to control your music from the frame.'
        : 'Spotify isn\'t set up yet (missing Client ID).';
      FD.$('mini').classList.add('hidden');
      setArt('');
      return;
    }

    var info = player && trackInfo(player.item);
    FD.$('np-title').textContent = info ? info.title : 'Nothing playing';
    FD.$('np-artist').textContent = info ? info.artist : 'Pick a device or a playlist to start.';
    FD.$('np-album').textContent = info ? info.album : '';
    setArt(info ? info.art : '');

    var playing = !!(player && player.is_playing);
    FD.$('btn-play').classList.toggle('playing', playing);
    FD.$('btn-shuffle').classList.toggle('on', !!(player && player.shuffle_state));
    var repeat = player ? player.repeat_state : 'off';
    FD.$('btn-repeat').classList.toggle('on', repeat !== 'off');
    FD.$('btn-repeat').classList.toggle('one', repeat === 'track');

    var dev = player && player.device;
    FD.$('np-device').textContent = dev ? dev.name : 'Pick a device';
    var canVolume = !!(dev && dev.supports_volume !== false && dev.volume_percent !== null);
    FD.$('vol-wrap').style.visibility = canVolume ? 'visible' : 'hidden';
    if (canVolume && !volBusy) FD.$('vol').value = dev.volume_percent;

    // Header mini player (visible from the calendar tab too)
    FD.$('mini').classList.toggle('hidden', !info);
    if (info) {
      FD.$('mini-title').textContent = info.title;
      FD.$('mini-artist').textContent = info.artist;
      var thumb = info.thumb || info.art;
      if (FD.$('mini-art').getAttribute('src') !== thumb) FD.$('mini-art').src = thumb;
    }

    renderProgress();
  }

  /* ---------- Pickers ---------- */

  function openDevices() {
    FD.openSheet('Play on…', '<div class="sheet-note">Looking for devices…</div>');
    api('GET', '/me/player/devices', null, function (err, status, data) {
      var list = (data && data.devices) || [];
      if (err) {
        FD.$('sheet-body').innerHTML = '<div class="sheet-note">' + FD.esc(errorText(status, data)) + '</div>';
        return;
      }
      if (!list.length) {
        FD.$('sheet-body').innerHTML = '<div class="sheet-note">No devices found. Open Spotify on your phone, ' +
          'computer, or speaker, then tap Refresh.</div>' +
          '<div class="sheet-foot"><button class="chip" data-refresh>Refresh</button></div>';
        return;
      }
      FD.$('sheet-body').innerHTML = list.map(function (d) {
        return '<button class="dev' + (d.is_active ? ' active' : '') + '" data-device="' + FD.esc(d.id) + '">' +
          '<span class="dev-name">' + FD.esc(d.name) + '</span>' +
          '<span class="dev-type">' + (d.is_active ? 'Playing here' : FD.esc(d.type)) + '</span></button>';
      }).join('') +
        '<div class="sheet-foot"><button class="chip" data-signout>Disconnect Spotify</button></div>';
    });
  }

  function openPlaylists() {
    FD.openSheet('Playlists', '<div class="sheet-note">Loading playlists…</div>');
    api('GET', '/me/playlists?limit=50', null, function (err, status, data) {
      if (err) {
        FD.$('sheet-body').innerHTML = '<div class="sheet-note">' + FD.esc(errorText(status, data)) + '</div>';
        return;
      }
      var items = (data && data.items) || [];
      if (!items.length) {
        FD.$('sheet-body').innerHTML = '<div class="sheet-note">No playlists found.</div>';
        return;
      }
      FD.$('sheet-body').innerHTML = '<div class="tiles">' + items.map(function (p) {
        var imgs = p.images || [];
        var img = imgs.length ? imgs[imgs.length > 1 ? 1 : 0].url : '';
        return '<button class="tile" data-uri="' + FD.esc(p.uri) + '">' +
          (img ? '<img src="' + FD.esc(img) + '" alt="">' : '<div class="ph"></div>') +
          '<span>' + FD.esc(p.name) + '</span></button>';
      }).join('') + '</div>';
    });
  }

  function playContext(uri) {
    FD.closeSheet();
    var path = '/me/player/play';
    // No active device: aim at the last one we saw so it can wake up.
    var last = FD.store.get('sp.lastDevice');
    if (!(player && player.device) && last) path += '?device_id=' + encodeURIComponent(last);
    command('PUT', path, { context_uri: uri });
  }

  function onSheetClick(e) {
    var el = FD.closestAttr(e.target, 'data-device');
    if (el) {
      FD.closeSheet();
      command('PUT', '/me/player', { device_ids: [el.getAttribute('data-device')], play: true });
      return;
    }
    el = FD.closestAttr(e.target, 'data-uri');
    if (el) { playContext(el.getAttribute('data-uri')); return; }
    if (FD.closestAttr(e.target, 'data-refresh')) { openDevices(); return; }
    if (FD.closestAttr(e.target, 'data-signout')) { FD.closeSheet(); signOut(); }
  }

  /* ---------- Wiring ---------- */

  function bind() {
    FD.$('sp-login').addEventListener('click', function () { login(!!FD.spotify.handoffMode); });

    FD.$('btn-play').addEventListener('click', function () {
      if (!player || !player.device) { openDevices(); return; }
      if (player.is_playing) {
        command('PUT', '/me/player/pause', null, function (p) {
          p.progress_ms = progressNow(); polledAt = Date.now(); p.is_playing = false;
        });
      } else {
        command('PUT', '/me/player/play', null, function (p) { polledAt = Date.now(); p.is_playing = true; });
      }
    });
    FD.$('btn-next').addEventListener('click', function () { command('POST', '/me/player/next'); });
    FD.$('btn-prev').addEventListener('click', function () { command('POST', '/me/player/previous'); });
    FD.$('btn-shuffle').addEventListener('click', function () {
      if (!player) return;
      var next = !player.shuffle_state;
      command('PUT', '/me/player/shuffle?state=' + next, null, function (p) { p.shuffle_state = next; });
    });
    FD.$('btn-repeat').addEventListener('click', function () {
      if (!player) return;
      var order = ['off', 'context', 'track'];
      var next = order[(order.indexOf(player.repeat_state) + 1) % order.length];
      command('PUT', '/me/player/repeat?state=' + next, null, function (p) { p.repeat_state = next; });
    });

    FD.$('np-bar').addEventListener('click', function (e) {
      if (!player || !player.item) return;
      var rect = FD.$('np-bar').getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var pos = Math.round(frac * player.item.duration_ms);
      command('PUT', '/me/player/seek?position_ms=' + pos, null, function (p) {
        p.progress_ms = pos; polledAt = Date.now();
      });
    });

    var vol = FD.$('vol');
    vol.addEventListener('touchstart', function () { volBusy = true; });
    vol.addEventListener('mousedown', function () { volBusy = true; });
    vol.addEventListener('change', function () {
      volBusy = false;
      var v = parseInt(vol.value, 10);
      command('PUT', '/me/player/volume?volume_percent=' + v, null, function (p) {
        if (p.device) p.device.volume_percent = v;
      });
    });

    FD.$('btn-device').addEventListener('click', openDevices);
    FD.$('btn-lists').addEventListener('click', openPlaylists);
    FD.$('sheet-body').addEventListener('click', onSheetClick);
    FD.$('mini').addEventListener('click', function () { FD.show('music'); });

    FD.onShow(function (name) { if (name === 'music' && tok) poll(); });
    setInterval(function () { if (FD.current() === 'music') renderProgress(); }, 500);
  }

  FD.spotify = {
    handoffMode: false,
    init: function (q) {
      this.handoffMode = q.handoff === '1';
      // One-time token import (?sprt=REFRESH_TOKEN), used when signing in on
      // another computer is easier than signing in on the frame.
      if (q.sprt) {
        tok = { a: '', r: q.sprt, x: 0 };
        FD.store.set('sp.tok', tok);
      }
      bind();
      render();
      handleRedirect(q);
      poll();
    }
  };
})();
