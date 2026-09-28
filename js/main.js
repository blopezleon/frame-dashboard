/* Startup. Query params the page understands (all optional, used once):
     ?cal=<Apps Script web app URL>   save the calendar feed address
     ?sprt=<Spotify refresh token>    import a Spotify login made elsewhere
     ?handoff=1                       sign in to Spotify here, then show the token
     ?view=cal|week|music|ambient    open on a tab */
(function () {
  'use strict';

  var FD = window.FD;
  var q = FD.parseQuery(location.search);

  if (q.cal) {
    var cfg = FD.store.get('cfg') || {};
    cfg.cal = q.cal;
    FD.store.set('cfg', cfg);
  }

  FD.initCore();
  FD.weather.init();
  FD.calendar.init();
  FD.spotify.init(q);
  FD.ambient.init();
  FD.show(q.view || (q.code ? 'music' : FD.store.get('view')) || 'cal');

  // Keep secrets and one-time codes out of the address bar once they're consumed.
  if (location.search && q.handoff !== '1' && window.history && history.replaceState) {
    history.replaceState(null, '', location.pathname);
  }

  // Reload once a night so the frame picks up new versions of this page.
  var now = new Date();
  var fourAm = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() >= 4 ? 1 : 0), 4, 0, 0);
  setTimeout(function () { location.reload(); }, fourAm - now);
})();
