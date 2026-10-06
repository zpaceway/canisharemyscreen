# Can I Share My Screen

A dark, rose-accented recording studio built with React, Vite, TypeScript, and Tailwind CSS.

## Development

Use a current Node.js release supported by Vite (20.19+ or 22.12+).

```sh
npm ci
npm run dev
```

```sh
npm run build
npm run preview
npm run lint
npm test
```

The Playwright configuration uses installed Google Chrome. Install Chrome before running the tests, or change the project to Playwright's bundled Chromium and run `npx playwright install chromium`.

The optional capture soak can run for an arbitrary duration:

```sh
SOAK_SECONDS=60 npm test -- --grep 'optional long-session'
```

Production recording/export smoke tests:

```sh
npm run build
TEST_PRODUCTION=1 npm test -- --grep 'minimal initial|responsive|camera bubble|download button|browser ending'
```

The real hidden-tab regression requires a graphical display and headed Chrome. It removes Playwright's default background-throttling exemptions and verifies that the recording tab actually becomes hidden:

```sh
BACKGROUND_TEST=1 npm test -- --grep 'another tab'
```

## Recording architecture

- Screen selection uses `getDisplayMedia`; camera and mic use `getUserMedia`. In supported Chromium browsers, track processors transfer captured video-frame streams to a dedicated OffscreenCanvas compositor worker. A generated video track carries the composed frames to MediaRecorder. Incoming screen or camera frames drive composition, not main-thread timers or HTML video playback. Each input retains at most one cached frame, with bounded processor buffers and output backpressure. Camera size, position, clipping, mirroring and border are embedded in the output. The UI preview is a separate best-effort canvas loop.
- Web Audio mixes mic and captured source audio, with separate gain controls. Neither preview audio nor mic audio is played through speakers.
- `MediaRecorder` emits chunks at a requested one-second interval. A dedicated worker appends these **ordered chunks from one recorder** into an OPFS file. Each write handles short writes, flushes to disk, then acknowledges its committed offset.
- Versioned recovery manifests are updated only after acknowledgements. Playback and export use disk-backed Blob slices up to that offset. They do not read the entire recording into a JavaScript array.
- Pending encoded data is capped at 32 MiB. Disk failure, stalled writes, oversized chunks, or critically low quota stop recording and retain the committed prefix. Browser/native codec allocations are outside this application's control.
- The original WebM is streamed to a chosen destination. Without the save-file API, the original disk-backed Blob can use the browser download path.
- MP4 and compression run in a separate worker. Mediabunny reads ranges with an 8 MiB cache and writes in 1 MiB chunks with backpressure. MP4 is fragmented to avoid a whole-session sample table. WebM export retains a seek index, whose metadata can grow with duration, but not the complete encoded media payload.
- The AAC extension is registered only when native AAC encoding is unavailable. It processes audio samples incrementally; there is no whole-file FFmpeg filesystem or input buffer.
- Conversion rejects discarded tracks rather than silently dropping audio or video. Cancellation aborts the destination's temporary write, retaining both the original recording and any previously existing destination contents.

## Browser and storage constraints

Recording targets desktop Chrome and Edge over HTTPS or localhost. System audio depends on the chosen source, browser, and operating system; selecting a source never guarantees an audio track. The capture request explicitly asks the picker to offer system/window audio where supported. Enable “Share audio” in the browser picker when available. For browser audio, select the tab playing it; this captures that tab, not every application. Audio settings show a separate screen-audio level meter when a track is provided, or a persistent missing-track message with the volume slider disabled. Increasing volume cannot enable capture when the browser supplies no audio track.

OPFS is browser-managed storage subject to quota and disk availability. Persistence is requested but may be denied. Clearing site data removes recovery copies. Recovery requires reopening the same origin (scheme, hostname, and port). Saved sessions remain until explicitly discarded, including after successful export.

Main-thread timers can be throttled in hidden tabs; the frame-driven Chromium recording path doesn't depend on them. Browsers lacking track processors/generators fall back to canvas capture with an explicit warning to keep the recorder tab active. Browsers can still suspend native capture or entire pages, and OS sleep, crashes, storage eviction and power loss cannot be prevented. A screen wake lock is requested and reacquired when possible. Recovery is best effort; the last uncommitted chunk is intentionally ignored.

There is no artificial recording-duration cap. Multi-hour sessions still require sufficient space and real-device validation; a short automated soak is not proof of multi-hour reliability.

MP4 exports use fragmented H.264/AAC. Most modern players support them, but duration display and seeking support vary. Original MediaRecorder WebM can lack a duration/seek index. Compressed WebM is remuxed with an index.

## Configuration references

- [React: starting a Vite application](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite: current setup and Node requirements](https://vite.dev/guide/)
- [Tailwind: official Vite plugin configuration](https://tailwindcss.com/docs/installation/using-vite)
- [OPFS and synchronous worker file access](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [Mediabunny source, conversion and output documentation](https://github.com/Vanilagy/mediabunny/tree/main/docs/guide)

Dependencies use the current stable releases verified during setup; `package-lock.json` records the installed versions. The local agent skills in `.agents/` are development tooling and are ignored by git; `skills-lock.json` records how to restore them with the skills CLI.
