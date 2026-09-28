/* Public settings. The Spotify Client ID is not a secret (PKCE login has no
   client secret). The calendar feed URL is NOT stored here; see main.js. */
window.FD_CONFIG = {
  spotifyClientId: '7a5a0a462461436ba669b75cb42865bd',
  redirectUri: 'https://blopezleon.github.io/frame-dashboard/',
  weather: { lat: 29.6516, lon: -82.3248, place: 'Gainesville' }
};
