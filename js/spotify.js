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
    'playlist-read-collaborative',
    'user-library-read'
  ].join(' ');
  var PAGE = 50;     // tracks per API request
  var BLOCK = 20;    // rows per rendered chunk of the track list
  var ROW = 72;      // track row height in px; must match .trk in style.css

  var tok = FD.store.get('sp.tok');   // { a: access, r: refresh, x: expiry ms }
  var player = null;                  // last GET /me/player response
  var polledAt = 0;
  var pollTimer = null;
  var backoffUntil = 0;
  var refreshing = null;              // queued callbacks while a refresh is in flight
  var volBusy = false;
  var shownArt = null;
  var lists = null;                   // cached /me/playlists items, for "back"
  var meId = null;
  var tl = null;                      // open track list (see openTracks)

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
    markPlaying();
  }

  /* ---------- Pickers ---------- */

  function openDevices() {
    tl = null;
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

  var HEART = '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  function openPlaylists() {
    tl = null;
    FD.openSheet('Playlists', '<div class="sheet-note">Loading playlists…</div>');
    if (!meId) api('GET', '/me', null, function (err, status, data) { if (!err && data) meId = data.id; });
    api('GET', '/me/playlists?limit=50', null, function (err, status, data) {
      if (err) {
        FD.$('sheet-body').innerHTML = '<div class="sheet-note">' + FD.esc(errorText(status, data)) + '</div>';
        return;
      }
      lists = (data && data.items) || [];
      renderPlaylists();
    });
  }

  // Tapping a tile opens its song list; playing happens from there.
  function renderPlaylists() {
    tl = null;
    FD.openSheet('Playlists', '<div class="tiles">' +
      '<button class="tile" data-list="liked"><div class="ph liked">' + HEART + '</div><span>Liked Songs</span></button>' +
      lists.map(function (p, i) {
        var imgs = p.images || [];
        var img = imgs.length ? imgs[imgs.length > 1 ? 1 : 0].url : '';
        return '<button class="tile" data-list="' + i + '">' +
          (img ? '<img src="' + FD.esc(img) + '" alt="">' : '<div class="ph"></div>') +
          '<span>' + FD.esc(p.name) + '</span></button>';
      }).join('') + '</div>');
  }

  /* ---------- Track list ----------
     Liked Songs can be thousands of tracks, so the list is virtual: a spacer
     sized for every row, with only the chunks of rows near the viewport in
     the DOM. Pages of 50 are fetched only once the scrolling settles on them. */

  function openTracks(src) {
    var body = FD.$('sheet-body');
    tl = { src: src, total: -1, pages: {}, loading: {}, blocks: {}, fetchTimer: null, raf: 0 };
    FD.$('sheet-title').textContent = src.name;
    body.className = 'sheet-body tracks';
    body.innerHTML = '<div class="trk-bar">' +
      '<button class="chip" data-back><svg viewBox="0 0 24 24"><path d="M15.4 7.4L14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>Playlists</button>' +
      '<span id="trk-count" class="trk-count"></span>' +
      '<button class="chip" data-playall><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>Play</button></div>' +
      '<div id="trk-scroll" class="trk-scroll scroll"><div id="trk-space" class="trk-space">' +
      '<div class="sheet-note">Loading songs…</div></div></div>';
    FD.$('trk-scroll').addEventListener('scroll', onTrackScroll);
    loadPage(tl, 0);
  }

  function tracksPath(src, offset) {
    if (src.kind === 'liked') return '/me/tracks?limit=' + PAGE + '&offset=' + offset;
    return '/playlists/' + encodeURIComponent(src.id) + '/items?limit=' + PAGE + '&offset=' + offset;
  }

  // Playlist entries use .item since Spotify's 2026 API change; liked songs use .track.
  function entryInfo(e) {
    var it = e && (e.item || e.track);
    if (!it || !it.uri) return null;
    var info = trackInfo(it);
    info.uri = it.uri;
    info.dur = it.duration_ms || 0;
    return info;
  }

  function loadPage(t, p) {
    if (t.pages[p] || t.loading[p]) return;
    t.loading[p] = true;
    api('GET', tracksPath(t.src, p * PAGE), null, function (err, status, data) {
      t.loading[p] = false;
      if (t !== tl) return;   // the sheet has moved on
      if (err) {
        // Later pages just retry on the next scroll; the first one shows why.
        if (t.total < 0) FD.$('trk-space').innerHTML = '<div class="sheet-note">' + FD.esc(tracksError(t.src, status, data)) + '</div>';
        return;
      }
      t.pages[p] = ((data && data.items) || []).map(entryInfo);
      if (t.total < 0) {
        t.total = (data && data.total) || 0;
        FD.$('trk-count').textContent = t.total === 1 ? '1 song' : t.total + ' songs';
        var space = FD.$('trk-space');
        space.innerHTML = t.total ? '' : '<div class="sheet-note">No songs here yet.</div>';
        space.style.height = t.total * ROW + 'px';
      }
      // Re-render chunks showing placeholders for this page.
      for (var b = Math.floor(p * PAGE / BLOCK); b * BLOCK < (p + 1) * PAGE; b++) dropBlock(t, b);
      updateTracks();
    });
  }

  function tracksError(src, status, data) {
    if (status === 403 && src.kind === 'liked') {
      return 'Liked Songs needs a fresh Spotify sign-in (the current one wasn\'t allowed to read your library).';
    }
    if (status === 403 || status === 404) {
      return 'Spotify only lists the songs of playlists you own or collaborate on. You can still play it.';
    }
    return errorText(status, data);
  }

  function onTrackScroll() {
    var t = tl;
    if (!t || t.raf) return;
    t.raf = requestAnimationFrame(function () { t.raf = 0; if (t === tl) updateTracks(); });
  }

  function updateTracks() {
    var t = tl, sc = FD.$('trk-scroll');
    if (!t || !sc || t.total <= 0) return;
    var top = sc.scrollTop, h = sc.clientHeight, span = BLOCK * ROW;
    // Keep about a screen of rows above and below the visible ones.
    var first = Math.max(0, Math.floor((top - h) / span));
    var last = Math.min(Math.ceil(t.total / BLOCK) - 1, Math.floor((top + 2 * h) / span));
    Object.keys(t.blocks).forEach(function (k) { if (k < first || k > last) dropBlock(t, +k); });
    for (var b = first; b <= last; b++) if (!t.blocks[b]) renderBlock(t, b);

    // A fling passes over many pages; only fetch where it comes to rest.
    clearTimeout(t.fetchTimer);
    t.fetchTimer = setTimeout(function () {
      if (t !== tl) return;
      var p0 = Math.floor(Math.max(0, sc.scrollTop - h / 2) / ROW / PAGE);
      var p1 = Math.floor(Math.min(t.total - 1, (sc.scrollTop + 1.5 * h) / ROW) / PAGE);
      for (var p = p0; p <= p1; p++) loadPage(t, p);
    }, 150);
  }

  function dropBlock(t, b) {
    var el = t.blocks[b];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete t.blocks[b];
  }

  function renderBlock(t, b) {
    var nowUri = player && player.item && player.item.uri;
    var end = Math.min(t.total, (b + 1) * BLOCK);
    var html = '';
    for (var i = b * BLOCK; i < end; i++) {
      var page = t.pages[Math.floor(i / PAGE)];
      var n = '<span class="trk-n">' + (i + 1) + '</span>';
      if (!page) {
        html += '<div class="trk ph">' + n + '<span class="trk-img"></span>' +
          '<span class="trk-text"><span class="trk-title"></span><span class="trk-artist"></span></span></div>';
        continue;
      }
      var s = page[i % PAGE];
      if (!s) {
        html += '<div class="trk gone">' + n + '<span class="trk-img"></span>' +
          '<span class="trk-text"><span class="trk-title">Unavailable</span></span></div>';
        continue;
      }
      html += '<button class="trk' + (s.uri === nowUri ? ' on' : '') + '" data-track="' + i + '" data-turi="' + FD.esc(s.uri) + '">' + n +
        (s.thumb || s.art ? '<img src="' + FD.esc(s.thumb || s.art) + '" alt="">' : '<span class="trk-img"></span>') +
        '<span class="trk-text"><span class="trk-title">' + FD.esc(s.title) + '</span>' +
        '<span class="trk-artist">' + FD.esc(s.artist) + '</span></span>' +
        '<span class="trk-dur">' + FD.fmtDuration(s.dur) + '</span></button>';
    }
    var el = document.createElement('div');
    el.className = 'trk-block';
    el.style.top = b * BLOCK * ROW + 'px';
    el.innerHTML = html;
    FD.$('trk-space').appendChild(el);
    t.blocks[b] = el;
  }

  // Highlight the playing song in the open list (called on every poll).
  function markPlaying() {
    if (!tl || !FD.$('trk-space')) return;
    var nowUri = player && player.item && player.item.uri;
    Array.prototype.forEach.call(FD.$('trk-space').querySelectorAll('[data-turi]'), function (el) {
      el.classList.toggle('on', el.getAttribute('data-turi') === nowUri);
    });
  }

  function playTrack(i) {
    var src = tl.src;
    if (src.kind === 'playlist') { startPlayback({ context_uri: src.uri, offset: { position: i } }); return; }
    // Liked Songs: play the library as a context so it keeps going. If Spotify
    // refuses that, fall back to queueing the loaded songs from here on.
    var uris = [];
    for (var j = i; uris.length < 100 && j < tl.total; j++) {
      var page = tl.pages[Math.floor(j / PAGE)];
      if (!page) break;
      if (page[j % PAGE]) uris.push(page[j % PAGE].uri);
    }
    if (!uris.length) return;
    var fallback = function () { startPlayback({ uris: uris }); };
    if (!meId) { fallback(); return; }
    startPlayback({ context_uri: 'spotify:user:' + meId + ':collection', offset: { uri: uris[0] } }, fallback);
  }

  function playAll() {
    var src = tl.src;
    if (src.kind === 'playlist') { playContext(src.uri); return; }
    if (tl.total > 0 && tl.pages[0]) playTrack(0);
  }

  function playContext(uri) {
    FD.closeSheet();
    startPlayback({ context_uri: uri });
  }

  // PUT /me/player/play; fallback runs instead of an error toast if Spotify
  // rejects the request itself (not "no device" or rate limiting).
  function startPlayback(body, fallback) {
    var path = '/me/player/play';
    // No active device: aim at the last one we saw so it can wake up.
    var last = FD.store.get('sp.lastDevice');
    if (!(player && player.device) && last) path += '?device_id=' + encodeURIComponent(last);
    api('PUT', path, body, function (err, status, data) {
      if (err && fallback && status !== 404 && status !== 429) { fallback(); return; }
      if (err) {
        FD.toast(errorText(status, data));
        if (status === 404) openDevices();
      }
      setTimeout(poll, 700);
    });
  }

  function onSheetClick(e) {
    var el = FD.closestAttr(e.target, 'data-device');
    if (el) {
      FD.closeSheet();
      command('PUT', '/me/player', { device_ids: [el.getAttribute('data-device')], play: true });
      return;
    }
    el = FD.closestAttr(e.target, 'data-list');
    if (el) {
      var key = el.getAttribute('data-list');
      var p = lists[+key];
      openTracks(key === 'liked' ? { kind: 'liked', name: 'Liked Songs' }
        : { kind: 'playlist', id: p.id, uri: p.uri, name: p.name });
      return;
    }
    el = FD.closestAttr(e.target, 'data-track');
    if (el && tl) { playTrack(+el.getAttribute('data-track')); return; }
    if (FD.closestAttr(e.target, 'data-playall') && tl) { playAll(); return; }
    if (FD.closestAttr(e.target, 'data-back') && lists) { renderPlaylists(); return; }
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
