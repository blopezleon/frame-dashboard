# Frame Dashboard

Touch dashboard for a Dragon Touch Modern10 Charm photo frame (Android 6, Fully Kiosk Browser).
Two tabs, switched by tapping or swiping: **Calendar** (Google Calendar via an Apps Script feed) and **Music** (Spotify Connect remote).

- Written in ES5 with no build step, because the frame's WebView is Chrome 44.
- `apps-script/Code.gs` is the calendar feed. Deploy it as a web app and open the page once with `?cal=<web app URL>?key=<KEY>` (URL-encoded).
- The Spotify login uses PKCE; the Client ID lives in `config.js`.
