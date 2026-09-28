/* Ambient tab: full-screen looping clips from ambient/playlist.json,
   shuffled every 30 minutes. Tap to show the tab bar and a Next button.
   The video only plays while this tab is open. */
(function () {
  'use strict';

  var FD = window.FD;
  var SWITCH_MS = 30 * 60 * 1000;
  var UI_MS = 5000;

  var clips = [];
  var video, fade;
  var uiTimer = null;

  // Shuffle-bag: every clip plays once before any repeats.
  function nextClip() {
    if (!clips.length) return null;
    var bag = FD.store.get('amb.bag') || [];
    bag = bag.filter(function (f) { return clipByFile(f); });
    var current = FD.store.get('amb.current');
    if (!bag.length) {
      bag = clips.map(function (c) { return c.file; });
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
      }
      // Don't start a new round with the clip that just played.
      if (bag.length > 1 && current && bag[0] === current.file) bag.push(bag.shift());
    }
    var file = bag.shift();
    FD.store.set('amb.bag', bag);
    FD.store.set('amb.current', { file: file, since: Date.now() });
    return clipByFile(file);
  }

  function clipByFile(file) {
    for (var i = 0; i < clips.length; i++) if (clips[i].file === file) return clips[i];
    return null;
  }

  // The clip that should be showing now; rotates every SWITCH_MS.
  function currentClip() {
    var cur = FD.store.get('amb.current');
    var clip = cur && clipByFile(cur.file);
    if (!clip || Date.now() - cur.since >= SWITCH_MS) clip = nextClip();
    return clip;
  }

  // The frame's built-in video player can't stream from modern HTTPS sites
  // (its TLS is too old), so the browser downloads the clip and hands the
  // bytes to the hardware decoder through Media Source Extensions.
  // Clips must be fragmented MP4 (tools/animate.py and tools/add-clip.sh do this).
  var CODEC = 'video/mp4; codecs="avc1.4D4028"';
  var shownFile = null;
  var objectUrl = null;
  var loadSeq = 0;

  function show(clip) {
    if (!clip) return;
    FD.$('amb-name').textContent = clip.title || '';
    if (shownFile === clip.file) { play(); return; }
    shownFile = clip.file;
    var seq = ++loadSeq;
    fade.classList.remove('clear');

    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'ambient/' + clip.file, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (seq !== loadSeq) return;  // another clip was picked meanwhile
      if (xhr.status !== 200) { failed(); return; }
      attach(xhr.response, clip.codec || CODEC, seq);
    };
    xhr.onerror = failed;
    xhr.send();
  }

  function attach(bytes, codec, seq) {
    var ms = new MediaSource();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', function () {
      if (seq !== loadSeq) return;
      try {
        var sb = ms.addSourceBuffer(codec);
        sb.addEventListener('updateend', function () {
          if (ms.readyState === 'open') ms.endOfStream();
          play();
        });
        sb.appendBuffer(bytes);
      } catch (e) { failed(); }
    });
    setTimeout(function () {  // let the fade to black finish first
      if (seq !== loadSeq) return;
      video.src = objectUrl;
    }, 600);
  }

  function failed() {
    // Broken or missing clip: move on to the next one.
    shownFile = null;
    setTimeout(function () { if (FD.current() === 'ambient') show(nextClip()); }, 3000);
  }

  function play() {
    if (FD.current() !== 'ambient') return;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function tick() {
    if (FD.current() === 'ambient') show(currentClip());
  }

  function showUi() {
    document.body.classList.add('show-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(function () { document.body.classList.remove('show-ui'); }, UI_MS);
  }

  function loadPlaylist(cb) {
    FD.request({ url: 'ambient/playlist.json?_=' + Date.now() }, function (err, status, data) {
      if (!err && data && data.clips && data.clips.length) {
        clips = data.clips;
        FD.store.set('amb.playlist', clips);
      } else {
        clips = FD.store.get('amb.playlist') || [];
      }
      if (cb) cb();
    });
  }

  FD.ambient = {
    init: function () {
      video = FD.$('amb-video');
      fade = FD.$('amb-fade');

      video.addEventListener('playing', function () { fade.classList.add('clear'); });
      video.addEventListener('error', failed);
      // Belt and braces for looping a MediaSource stream on old WebViews.
      video.addEventListener('ended', function () { video.currentTime = 0; play(); });

      FD.$('view-ambient').addEventListener('click', function (e) {
        if (e.target === FD.$('amb-skip')) return;
        if (document.body.classList.contains('show-ui')) document.body.classList.remove('show-ui');
        else showUi();
      });
      FD.$('amb-skip').addEventListener('click', function () {
        show(nextClip());
        showUi();
      });

      FD.onShow(function (name) {
        document.body.classList.remove('show-ui');
        if (name === 'ambient') {
          show(currentClip());
          showUi();  // briefly show the tabs so it's clear how to leave
        } else {
          video.pause();
        }
      });

      loadPlaylist(function () { if (FD.current() === 'ambient') tick(); });
      setInterval(tick, 60 * 1000);
    }
  };
})();
