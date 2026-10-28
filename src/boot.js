// Classic (non-module) script: runs even where ES modules can't load, such as
// file://, and explains why the app can't start there.
(function () {
  var msg = null;
  if (location.protocol === 'file:') {
    msg = 'Browsers block this app when it is opened as a file. Start the local server instead: run "python3 serve.py" in the project folder, then open http://localhost:8000.';
  } else if (!window.isSecureContext) {
    msg = 'Screen capture only works on secure pages. Open this app over https, or from http://localhost on the same computer.';
  } else if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    msg = 'This browser can’t capture the screen. Mobile browsers don’t support it; use a current desktop version of Chrome, Edge, Firefox or Safari.';
  } else if (typeof window.MediaRecorder === 'undefined') {
    msg = 'This browser can’t record video. Use a current desktop version of Chrome, Edge, Firefox or Safari.';
  }
  if (!msg) return;
  window.__recorderUnsupported = msg;
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.getElementById('unsupported');
    var app = document.getElementById('app');
    if (box) {
      box.querySelector('p').textContent = msg;
      box.hidden = false;
    }
    if (app) app.hidden = true;
  });
})();
