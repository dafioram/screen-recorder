# Screen Recorder

A small screen recorder that runs entirely in your browser. Pick a screen, window or tab, add your microphone and system audio if you like, and save the video to your computer. Nothing is uploaded: there is no server-side processing, no account and no tracking.

It's plain HTML, CSS and JavaScript with no build step and no dependencies.

## Features

- **Any source** your browser offers: an entire screen, a window or a browser tab.
- **Microphone and system audio**, mixed into one track, with live level meters and a mute button.
- **Quality presets**: Low (720p, 30 FPS), Standard (1080p, 30 FPS), High (native up to 4K, 60 FPS) or Custom resolution, frame rate and bitrate. The app shows what the browser actually delivers and a size-per-minute estimate.
- **Formats**: WebM, MP4 and MKV (H.264), each offered only when your browser can record it.
- **Split into files** every N seconds (30 s to 1 hour). Each file is standalone and playable. Keep them all until you stop, or download each one as it finishes.
- **Timer overlay**: a time count burned into a corner of the video, as elapsed time (MM:SS), clock time, or both.
- **Streaming to disk** with **crash recovery**: video is written to the browser's private storage every second, so long recordings don't fill your RAM, and a closed or crashed tab can be recovered on your next visit.
- 3-2-1 countdown, pause and resume, keyboard shortcuts, and remembered settings.

## Run it on your computer

Browsers only allow screen capture on secure pages. `http://localhost` counts as secure, so a tiny local server is all you need. Opening `index.html` by double-clicking won't work.

1. Install Python 3.7 or newer if you don't have it (macOS and most Linux systems already do).
2. In the project folder, run:

   ```sh
   python3 serve.py
   ```

   On Windows: `py serve.py` (or `python serve.py`).

3. Your browser opens at `http://localhost:8000`. Press **Ctrl+C** in the terminal to stop the server.

Options: `--port 9000` picks another port (if 8000 is busy, the next free one is used automatically), `--no-browser` skips opening a tab, and `--quiet` hides the request log.

The server listens on your own computer only. Opening the app from another device via your LAN address (for example `http://192.168.1.20:8000`) is **not** a secure page, so screen capture won't work there.

Any other static server works too, as long as you browse to `localhost`, for example `python3 -m http.server 8000`.

## Put it on GitHub Pages

1. Push this folder to a GitHub repository (the files at the repository root, or in `/docs`).
2. In the repository, go to **Settings → Pages**, choose **Deploy from a branch**, and pick your branch and folder.
3. Your recorder will be at `https://<user>.github.io/<repo>/`.

Pages serves HTTPS, which screen capture needs. All paths are relative, so the app works from a project subfolder. Nothing in the app depends on custom HTTP headers, which Pages can't set.

After you deploy, Pages may serve cached files for about 10 minutes, so reload once if you see a mix of old and new behaviour.

## Using it

1. Choose your options on the right: microphone, system audio, quality, format, splitting and the timer overlay.
2. Click **Select source** and pick what to share in the browser's dialog. To capture system audio, tick **Share audio** there.
3. Check the preview, then press **Record**. A 3-2-1 countdown runs first; **Start now** skips it.
4. **Pause** and **Stop** as needed. If you stop sharing from the browser's own bar, the recording is saved safely.
5. In the review panel, play, download or discard each file. **New recording** starts over.

Keyboard shortcuts (while the page has focus and you're not typing in a field): **R** record, **Space** pause/resume, **S** stop, **Esc** cancel the countdown.

Settings are locked while a recording is starting, running or saving, and remembered between visits.

## Browser support

The app checks what your browser can do instead of assuming. Formats your browser can't record aren't shown.

| | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| Screen, window, tab capture | Yes | Yes | Yes (no tab audio) |
| System audio | Tab audio; whole-screen audio on Windows and ChromeOS | Usually none | None |
| Formats | WebM, MP4, MKV | WebM | MP4 |
| Timer overlay | Off-thread (smooth in background tabs) | Canvas fallback | Canvas fallback |
| Pause and resume | Yes | Yes | Yes |
| Streaming to disk and recovery | Yes | Yes | Yes |

Test with current versions. Mobile browsers can't capture the screen, so the app shows an explanation there instead.

### Audio limitations

- System audio is best effort. Asking for it doesn't guarantee the browser shares any. If none comes back, the app tells you and lets you continue without it or pick another source.
- Sharing a **browser tab** in Chrome or Edge is the most reliable way to get system audio. Whole-screen audio depends on the operating system: Windows and ChromeOS support it in Chrome and Edge, while macOS generally doesn't.
- The microphone is never played back through your speakers, so there's no feedback.
- Microphone names appear only after you've allowed microphone access once.

## Storage, memory and recovery

- While recording, each second of video is written to the browser's private storage for this site (the Origin Private File System) instead of being held in memory. Recording length is limited by free disk space, not RAM. The app warns you before recording when free space covers less than about an hour.
- If the tab closes or crashes, everything written so far survives, minus about the last second. On your next visit the app offers to **Recover**, **Download as is** or **Delete** it.
- Downloads go wherever your browser saves files. The app can't choose a folder for you.
- Downloaded files are removed from browser storage the next time you open the app. Discarded files are removed right away.
- If browser storage isn't available (some private-browsing modes), the app falls back to keeping recordings in memory and warns you when they pass 1 GB.
- MP4 recordings in Chrome may only be written to disk when they finish, so for the best crash protection use WebM or MKV.

## Troubleshooting

- **“Screen Recorder can't run here”**: you opened the file directly, or used a non-secure address. Use `python3 serve.py` and `http://localhost:8000`, or the GitHub Pages URL.
- **macOS shows a black screen or blocks capture**: allow your browser under **System Settings → Privacy & Security → Screen & System Audio Recording**, then restart the browser.
- **No system audio**: share a tab in Chrome or Edge and tick **Share audio** in the dialog.
- **Several downloads blocked**: Chrome asks once before allowing a site to download multiple files. Allow it, or download files one at a time from the review panel.
- **Overlay stutters**: keep the recorder tab visible, lower the quality, or turn the overlay off. Firefox and Safari use a slower fallback for the overlay.

## Privacy

- All capture, encoding and storage happens on your device. The page's Content Security Policy blocks network requests entirely (`connect-src 'none'`).
- Screen capture always needs your click and the browser's own picker; the app can't bypass permission prompts.
- The microphone is requested only when you turn it on.
- When a session ends, every media track is stopped, the audio context is closed, workers are terminated and object URLs are revoked.
- Only your settings are stored in `localStorage`. Recordings live in the browser's private storage until downloaded or discarded.

## Project structure

```text
screen-recorder/
├── index.html             the page
├── styles.css             styles (light and dark)
├── serve.py               local server for http://localhost
├── package.json           only so the optional tests run as ES modules
├── src/
│   ├── boot.js            explains why the app can't start (file://, insecure page, mobile)
│   ├── app.js             startup and orchestration
│   ├── state.js           state machine, the single source of app state
│   ├── settings.js        remembered preferences
│   ├── capture.js         screen and microphone capture, error messages
│   ├── audio.js           one stable mixed audio track, level meters
│   ├── overlay.js         timer overlay compositor and drawing
│   ├── overlay.worker.js  overlay frames and the background-safe tick clock
│   ├── recorder.js        quality, formats, bitrate, MediaRecorder per file
│   ├── segmenter.js       split boundaries and file rollover
│   ├── storage.js         streaming to disk, quota checks, memory fallback
│   ├── storage.worker.js  sync-access-handle disk writes
│   ├── recovery.js        session metadata and crash recovery
│   ├── webm-duration.js   writes the duration into WebM/MKV files so they seek
│   ├── download.js        filenames, object URLs, downloads
│   ├── time.js            monotonic active-time clock and time formats
│   └── ui.js              rendering, controls, notices
└── tests/                 unit tests (Node's built-in runner)
```

How a recording flows: the display track (or the overlay's composited track) plus the single mixed audio track form one stream. Each output file gets its own `MediaRecorder` on that stream, so split files are standalone. Chunks arrive every second and are written straight to disk. When a file finishes, WebM and MKV get their duration patched in, without copying the video body.

## Tests

Optional, and not needed to use the app. With Node.js 18 or newer:

```sh
node --test
```

The tests cover the state machine, settings, format negotiation and bitrates, split timing and rollover, the WebM duration patch, recovery metadata, storage sinks, filenames and time formats. No packages are installed.

## Manual test checklist

Run through these in each browser you support (Chrome or Edge, Firefox, and Safari if targeted), on each operating system.

**Capture**
- [ ] A monitor, a window and a tab can each be selected where the browser offers them, with a live preview.
- [ ] The recorder's own tab isn't offered in the picker (Chrome and Edge).
- [ ] Cancelling the picker returns to Ready with no error and no active capture indicator.
- [ ] Denying screen access at the OS level shows an explanation.

**Audio**
- [ ] Screen only, screen plus mic, screen plus system audio, and both together each record, with exactly one audio track in the file.
- [ ] Denying the microphone shows Retry and Continue without microphone, and the app doesn't crash.
- [ ] With system audio on but not shared, the app offers to continue or choose another source.
- [ ] Muting the mic mid-recording leaves a playable file with silence where it was muted.
- [ ] Mic device names appear after permission and the list updates when a device is plugged in.

**Recording**
- [ ] The countdown runs, Start now skips it, and Esc or Cancel returns to the preview.
- [ ] Pause and resume give a playable file whose duration excludes the paused time.
- [ ] R, Space and S shortcuts work, and don't fire while typing in a field.
- [ ] Stopping sharing from the browser's bar saves the recording.
- [ ] Each quality preset records at the resolution and frame rate the app reports.

**Files**
- [ ] Downloaded WebM and MKV files show their duration and seek in VLC; WebM also in Chrome and Firefox.
- [ ] Every file's extension matches its container.
- [ ] With a 30 s split, a 3 min 10 s recording gives 7 files: six of about 30 s and one of about 10 s.
- [ ] No visible gap between consecutive split files in Chrome or Edge.
- [ ] "Download it right away" downloads each split file as it finishes.
- [ ] Discard asks for confirmation; New recording warns about files not yet downloaded.
- [ ] Leaving the page with undownloaded files shows the browser's leave-page warning.

**Overlay**
- [ ] The time shows in each corner and each format, freezes during pause, and matches the on-page timer.
- [ ] With "Restart the count in each split file", each file starts at 00:00.
- [ ] With the recorder tab hidden for 10 minutes, the overlay keeps a steady frame rate (Chrome and Edge).

**Storage and recovery**
- [ ] Memory use stays roughly flat during a 60-minute recording.
- [ ] Closing the tab mid-recording, then reopening the app, offers recovery and gives playable files in each format.
- [ ] Downloaded files are cleaned up from browser storage on the next visit.

**General**
- [ ] Settings are restored after a reload.
- [ ] The layout works at common desktop window sizes.
- [ ] All capture indicators disappear after stopping, discarding or cancelling.
- [ ] The browser's network panel shows no requests carrying media.
- [ ] The app runs unchanged from `localhost` and from a GitHub Pages project URL, with no admin rights.
