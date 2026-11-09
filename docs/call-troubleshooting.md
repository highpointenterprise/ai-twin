# Silent calls and inbound routing

## Apply the update with ngrok

1. Pull `main`, run `npm ci`, and restart the backend. For production mode, also run `npm run build` before `npm start`. Run one backend process per data directory; call contexts and active streams belong to that process.
2. Keep `ngrok http 8080` running. Set `PUBLIC_BASE_URL` in the backend environment to the displayed HTTPS origin, for example `https://your-domain.ngrok-free.app`. Do not append `/twilio`, `/media`, a port, or query parameters. Restart the backend after changing environment variables.
3. Under **Phone numbers**, select an inbound assistant and click **Refresh inbound route**. This writes the current inbound/status URLs to Twilio, even when the selected assistant has not changed. The first assignment also updates routing.
4. Under **Diagnostics**, verify the expected webhook/media URLs, provider configuration and assistant voice. An empty assistant voice now inherits `ELEVENLABS_VOICE_ID`; an explicit saved voice always wins. The `assistant-waits-for-user` opening mode intentionally remains quiet until the caller speaks.
5. Make one controlled call. Filter Diagnostics using its full Twilio Call SID. The local ngrok inspection page (`http://127.0.0.1:4040`) should show Twilio's POST and WebSocket upgrade. Use the Twilio call/debugger view for requests that never reach this backend.

## What changed

The ElevenLabs adapter previously rejected a clean WebSocket close unless an `isFinal` message had arrived. If the provider delivered audio, then closed normally after the app's end-of-input message, that rejection cleared queued audio before the configured speaking delay elapsed. A local WebSocket regression test reproduced the lost greeting. The adapter now accepts a clean code-1000/1005 close **only after end-of-input and nonempty audio**. Empty results, early disconnects, provider errors and abnormal closes still fail. This restores the original adapter's handling of normal end-of-stream without treating every close as success.

Blank persisted assistant voices also previously ignored `ELEVENLABS_VOICE_ID`, unlike the original startup-only configuration. Calls and meetings now resolve that default at session creation without changing saved assistant settings.

Inbound rejections now record the reason and a failed call-history entry. Media authentication failures explain which condition failed. Twilio Media Streams status callbacks expose provider-reported WebSocket failures. These diagnostics distinguish configuration/tunnel failures from speech-generation failures; they do not establish the cause of a particular live call until its log is inspected.

## Read the stages

| Last event or failure | Meaning and next check |
| --- | --- |
| `outbound.dial_requested` / `twilio.dial.failed` | The app attempted to place the call. Inspect HTTP status/provider code and Twilio account settings. |
| No `twilio.request` for an inbound call | The request did not reach this process. Check the number's Voice URL, current ngrok hostname, running backend and Twilio debugger. |
| `twilio.webhook_rejected` | Signature verification failed. Match `PUBLIC_BASE_URL` exactly to the HTTPS URL Twilio called and use the connected account's Auth Token. Signature validation remains enabled. |
| `inbound.rejected` | The log identifies an unassigned number, missing voice/provider configuration, capacity, or a credentials update in progress. |
| `media.awaiting_connection`, then `media.start_timeout` | The voice webhook returned a stream instruction but no authenticated stream started within 15 seconds. Check the ngrok WebSocket upgrade and `twilio.stream_status` errors. This warning does not automatically terminate the call. |
| `media.rejected` | Context, assistant, Call SID, token, duplicate-start or capacity validation failed. Use one backend process, a stable `STREAM_SECRET`, and no restart between dialing and stream connection. |
| `media.started` → `media.session_ready` | Twilio's stream authenticated and the agent was created. `media.audio_progress` shows received/sent packet and byte totals. |
| `stt.failed` / `stt.closed` | Deepgram could not connect/transcribe. HTTP 401/403 indicates key/access or network policy; review the provider error and Flux access. A transcription failure ends the session explicitly. |
| `session.opening` with waits-for-user | No greeting is expected. Speak and look for input bytes and `stt.event` with `EndOfTurn`. |
| `llm.requested` with `turn.failed` | OpenAI did not produce a usable reply. Inspect the sanitized status/code/message and model access. |
| `tts.connecting` / `tts.failed` | Check ElevenLabs API key, selected voice/model access, account credits and the reported HTTP/close code. |
| `tts.first_audio` → `speech.first_audio_sent` → `media.first_outbound_audio` | Audio was generated and sent to Twilio. Telephone output remains 8 kHz mu-law; Meet uses its separate PCM format. |
| `playback.mark_sent` → `playback.acknowledged` | Twilio acknowledged reaching the playback marker. This does not prove what the person heard on their device. |
| `playback.clear` / `speech.cancelled` | Interruption or shutdown cleared queued audio. Check nearby speech events and the assistant's interruption settings. |
| `speech.recovery_failed` / `call.ending` | Recovery speech also failed. The call ends instead of silently staying connected. |

## Log storage and export

Backend output uses UTC ISO timestamps and full Call SIDs, with connection/speech IDs for correlation. The log file is `DATA_DIR/logs/voice-agent.jsonl`; `.1` and `.2` retain rotated history, with approximately 5 MB per file. Logs are created with mode 0600 and remain under the gitignored `.data` directory by default. A storage-write failure is reported in the terminal and does not stop calls.

Diagnostics refreshes every three seconds, showing up to 500 events from the most recent 2,000-event buffer. Recent disk events reload after restart. Download exports the current filtered snapshot; the JSONL files retain additional history until rotation. Detailed legacy call traces remain in memory, while the diagnostic event files survive restart.

The diagnostic API is mounted only on the loopback admin service. No API keys, auth headers, signed query tokens or raw audio frames are intentionally logged; known configured secrets are redacted from error messages. Logs can include conversation text and call identifiers. Keep them private and share only the relevant call when troubleshooting.

Tests cover real local WebSocket connections through signed inbound/outbound webhooks, the media server, actual provider adapters and the shared engine, using simulated provider responses. They verify greetings, replies, format/stream identifiers and playback acknowledgements, plus clean/abnormal/empty closes, provider rejection and persistent redacted logs. Live Twilio/Deepgram/OpenAI/ElevenLabs calls remain unverified here because this cloud environment has no provider credentials and blocks those hosts.
