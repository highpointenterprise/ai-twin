# Self-hosted Google Meet and HeyGen

The meeting worker connects the existing voice agent to Google Meet through a Playwright-controlled Chromium browser. There is no Recall.ai account or dependency. Each meeting has its own browser process, virtual microphone/camera and conversation session. The selected assistant supplies its system prompt, first-message mode, Deepgram endpointing, OpenAI model, ElevenLabs voice, interruption rules and attached custom functions.

## Setup

1. Install dependencies with `npm ci` and Chromium with `npx playwright install --with-deps chromium`. An existing Chromium can be selected with `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. Run on a machine that supports Chromium and WebRTC. Keep Chromium's sandbox enabled; only use `MEET_CHROMIUM_NO_SANDBOX=true` inside a suitably isolated container where its sandbox cannot run.
2. Set `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, and `ELEVENLABS_API_KEY` securely in the server environment. Configure the assistant's ElevenLabs voice ID in **Assistants**. `ELEVENLABS_VOICE_ID` only seeds the initial assistant; changing that environment variable does not overwrite saved assistants.
3. Start with `npm run dev`, or `npm run build` and `npm start`. Open **Meetings**, select an assistant, paste the full `https://meet.google.com/abc-defg-hij` link, and supply any meeting context. Query parameters are removed from links. Nicknames, lookup links and Calendar event URLs are not supported.
4. Click **Send agent** and have the host admit it. Status moves through joining/waiting to active. A Google sign-in requirement is shown as **needs login**. The worker does not bypass admission or Google verification. Its default display name identifies it as an AI assistant.
5. Use **Leave meeting** to close the browser and any avatar session. Removing the agent or ending the meeting also ends its session; it does not attempt to rejoin.

Twilio credentials, `PUBLIC_BASE_URL` and `STREAM_SECRET` are only required for phone calls. Meetings can run independently. Defaults allow two concurrent meetings, a three-minute admission wait, a thirty-minute session and a five-minute idle timeout. The assistant's maximum duration also applies. API clients may configure duration/idle/admission limits within the validated bounds; the simple dashboard uses defaults. Audio processing and paid avatar sessions start only after admission.

## Optional Google login

Some meetings allow named guests; others require an authorized Google account. On a machine with a desktop display, run `npm run meet:login`. Complete sign-in and any verification yourself in the browser, then press Enter in the terminal. The helper saves a mode-0600 storage-state file in `.data/google-meet-storage-state.json` by default. Set `MEET_GOOGLE_STORAGE_STATE_PATH` to its absolute path and restart the backend.

The state file contains account session material. Keep it on the server, outside source control; do not upload it to the dashboard or share it. The default filename and `.data` are gitignored. A custom path also needs equivalent protection. Expired or rejected sessions require a fresh interactive sign-in. Google may reject automated Chromium sign-in or require renewed verification; this integration has no bypass. Use an account/environment that Google and the meeting host permit.

## HeyGen face and voice

This adapter uses **HeyGen LiveAvatar LITE**, which lets our existing agent supply its own speech. Set `LIVEAVATAR_API_KEY` and optionally `LIVEAVATAR_AVATAR_ID`, or enter the avatar ID per meeting. Use an avatar and API key available to your LiveAvatar account; access and credits for legacy HeyGen Streaming Avatar products may differ.

The backend creates the LITE session, sends signed 16-bit mono PCM at 24 kHz over the returned WebSocket, and receives render events. A separate browser iframe subscribes to LiveAvatar's LiveKit audio/video. The face is drawn into Meet's virtual camera; the corresponding avatar audio feeds its microphone. Raw ElevenLabs speech is not played a second time. Avatar API keys stay server-side; the receiver only gets a short-lived room token.

Meeting audio capture is confined to the main frame's remote WebRTC tracks. The avatar iframe has separate peer connections, so it does not feed its own speech back into transcription. Interruption mutes queued speech, sends the provider interrupt command and rejects stale playback completions. A provider end event plus observed audio drain is required before the engine considers the reply finished. If avatar setup or playback fails, the meeting stops with a visible error; it does not silently replace the requested avatar with another voice.

## Network and hosting

Run the backend, Next.js dashboard and workers on a trusted host with persistent local storage. This remains a single-process development workspace with a loopback admin API, not a multi-user hosted application. Each concurrent meeting consumes a Chromium process plus AI and optional avatar usage. Abrupt host termination can leave a provider session alive until its provider-side timeout; check active sessions/usage when recovering from a crash.

Allow the existing AI hosts (`api.deepgram.com`, `api.openai.com`, `api.elevenlabs.io`) and the Google Meet/sign-in assets and media endpoints required by your Google account/network. These include `meet.google.com`, `accounts.google.com`, Google static/API hosts and Google's dynamically selected media endpoints. Avatar mode also needs `api.liveavatar.com`, the WebSocket and LiveKit hosts returned by the session API, and their WebRTC/TURN media endpoints. HTTPS access alone is insufficient for WebRTC: configure UDP or an appropriate TURN/TLS path according to those providers' deployment guidance. This is not an exhaustive static domain list.

The worker honors inherited HTTP(S) proxy settings and restricts non-proxied WebRTC UDP when a proxy is configured. It does not bypass a managed network policy. The current cloud workspace permits package/repository hosts but blocks Meet and these provider services; provider credentials are absent. Live validation needs the deployment network configured through its environment settings, with secrets entered there rather than in chat.

## Modular boundaries

| Module | Responsibility |
| --- | --- |
| `server/core/ports.ts`, `server/speech/output.ts` | Audio format and playback interface shared with telephony |
| `server/engine/standard-session.ts` | Existing transcription, model, tools and speech orchestration |
| `server/meetings/service.ts` | Admission, assistant snapshot, limits, provider/session lifetime and cleanup |
| `server/meetings/browser-driver.ts` | Meet UI interaction, admission detection and worker lifecycle |
| `server/meetings/browser/media.ts` | Incoming 16 kHz PCM, outgoing 24 kHz audio and virtual video |
| `server/meetings/liveavatar.ts`, `browser/avatar.ts`, `output.ts` | HeyGen session/protocol, isolated media receiver and playback correlation |
| `server/meetings/store.ts`, `routes.ts` | Persistent session statuses and loopback control API |

Meetings attach only custom-function tools. Twilio transfers and DTMF are phone transport operations and are excluded from meeting sessions. Custom functions retain the existing HTTPS allowlist, credential-reference and idempotency contract. They receive the meeting UUID in `message.call.id`.

Admin endpoints: `GET /api/meetings/config`, `GET /api/meetings`, `POST /api/meetings`, `GET /api/meetings/:id`, `GET /api/meetings/:id/trace`, and `POST /api/meetings/:id/end`. These are not mounted on the public Twilio service. Session records persist in `DATA_DIR/meetings.json`; detailed transcripts/traces are in memory. A restart marks interrupted sessions failed and does not automatically rejoin.

## Validation and current limits

Run `npm test`, `npm run typecheck`, `npm run build` and, after Chromium installation, `npm run test:browser`. Unit/integration tests use provider doubles; browser tests use synthetic meeting pages and real browser media streams/worklets. The incoming-track event is simulated in the PCM conversion test. A separate local WebRTC peer test runs where direct UDP is available; it is explicitly skipped under this cloud image's managed `WebRtcIPHandling=disable_non_proxied_udp` policy. No automated test joins a real meeting, starts a paid provider session or proves real Google UI compatibility. Run the transport test on your deployment host too.

Before using this with customers, run a controlled meeting with two participants and your real providers. Confirm admission, a heard greeting, both-way speech, natural interruption, correct custom-function results, avatar lip sync, participant removal, and explicit leave. Repeat with a login-required meeting, denied admission and provider/network failure. Measure latency and audio/video sync on your deployment; neither success on every meeting nor a latency target is guaranteed.

Meet's UI can change; selectors currently target English guest/name, Ask to join/Join now and Leave call controls. The agent hears a mixed audio stream, without participant identity/diarization, screen-share understanding, visual reasoning or recording. It follows its prompt and responds to completed speech turns; it does not yet implement a separate meeting chair or addressed-speaker policy. Camera rendering depends on provider media and browser/network scheduling, so real lip-sync quality needs live verification.

Protocol reference: official [heygen-com/live-avatar-js-sdk](https://github.com/heygen-com/live-avatar-js-sdk/tree/8199ef6497a813dc0c1ace7b4f55115d5c69c362), especially `apps/demo/app/api/start-lite-session/route.ts`, `packages/js-sdk/src/LiveAvatarSession/SessionApiClient.ts`, and its LITE WebSocket events/chunking implementation. The SDK source was inspected because the documentation host was blocked in this environment.
