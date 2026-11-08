# AI Twin

Modular inbound/outbound calling and a self-hosted **Google Meet** agent, sharing **Deepgram Flux**, **OpenAI**, **ElevenLabs**, assistant prompts and custom functions. Optional **HeyGen LiveAvatar** renders the same speech as an animated face. The dashboard uses simple shadcn/ui components for meeting controls alongside assistants, tools, numbers and calls.

## Run locally

Node.js 24 and npm 11 were used for validation.

```sh
npm ci
npm run dev
```

The workspace runs on port 3000. The admin service binds to `127.0.0.1:8081`; Twilio voice webhooks/media use port 8080. The configuration workspace works without provider credentials. Live-call actions report the missing configuration instead of inventing credentials or simulating success.

For a production build of the local workspace:

```sh
npm run build
npm start
```

## Connect calling providers

Open **Phone numbers → Connect Twilio**, enter your Account SID and Auth Token, then click **Connect & load numbers**. The backend verifies the credentials, saves them encrypted in `DATA_DIR`, and loads your numbers immediately. No restart is needed. Saved Twilio credentials take precedence over environment variables and remain available after restarting. Your Auth Token is never returned by the API or saved in browser storage.

For the remaining providers, copy `.env.example` to `.env` **only if `.env` does not already exist**, and supply credentials securely. Never commit `.env`. Twilio credentials can also be configured using `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` on the server.

Loading numbers requires only a working Twilio connection. AI calling additionally requires `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PUBLIC_BASE_URL`, and `STREAM_SECRET` (a private random string of at least 32 characters). Set an ElevenLabs voice ID per assistant, or set `ELEVENLABS_VOICE_ID` before the first startup to seed the initial assistant. `TWILIO_PHONE_NUMBER` is an optional outbound fallback and must belong to the connected Twilio account.

`PUBLIC_BASE_URL` must be a public HTTPS **origin** forwarded to port 8080, with WebSocket support for `/media`. The README originally suggested `ngrok http 8080`; an installed/authenticated ngrok or another suitable tunnel can supply that origin. Never forward the admin service to the public Internet. Keep `ADMIN_PORT=8081` unless you also update the Next.js rewrite.

Required outbound hosts: `api.twilio.com`, `api.deepgram.com`, `api.openai.com`, and `api.elevenlabs.io`. This cloud environment currently denies those hosts and has no provider credentials, so real calls remain unvalidated.

1. Create/configure an assistant. Set its first-message mode, system prompt, voice, transcriber, speaking plans and call handling.
2. Create reusable tools under **Tools**, then attach them to the assistant.
3. In **Phone numbers**, connect Twilio and assign an assistant. Assignment updates that number's Twilio voice webhook once all calling providers are configured.
4. Click **Make a call** beside a number to select it as the outbound caller ID, or start a call under **Calls**. Call an assigned number for inbound conversations. Inspect the call state, transcript, and tool events.

See [Twilio connection and credential storage](docs/twilio-connection.md) for account changes, storage and troubleshooting.

## Features in this increment

- Fixed, wait-for-user, and model-generated first messages.
- Deepgram semantic end-of-turn confidence/timeout; configurable start delay, word/voice-duration interruption, acknowledgement/interruption phrases and backoff.
- ElevenLabs voice/model, stability, similarity and speed.
- Reusable **transferCall** tools with **blind or agentic warm transfer**, destination-description or caller-phrase routing, pre-transfer message, extension and ring timeout. Warm transfer holds the caller, privately briefs the recipient, verifies acceptance, then confirms both parties joined the conference. Failed attempts restore the original assistant and conversation.
- **DTMF** tools with tone duration/gap, w/W pauses, and incoming keypad events. Outbound tones use in-band audio; validate against your target IVR.
- **Custom function** tools with JSON Schema, HTTPS webhook, credential reference, timeout, result correlation and model continuation.
- Twilio voicemail detection: hang up or play an ElevenLabs message after the greeting, then hang up. Configurable unknown-answer handling.
- Best-effort English call-screening response and handoff wait.
- Persistent assistant/tool configuration and recent call history; active-call hangup and in-session traces.

See [warm transfer setup and recovery](docs/warm-transfer.md), [research and parity boundaries](docs/vapi-research.md), and [architecture](docs/architecture.md). This implements the requested initial scope; it is not every Vapi feature.

## Send an agent to Google Meet

Install Chromium (`npx playwright install --with-deps chromium`, or set `CHROMIUM_EXECUTABLE_PATH` to your existing installation). Supply the three AI provider keys and an ElevenLabs voice ID on the assistant. Open **Meetings**, choose the assistant, paste a Meet link and click **Send agent**. The self-hosted browser requests admission and starts the conversation after joining. Twilio credentials and a public webhook URL are unnecessary for meetings.

For an avatar, also configure `LIVEAVATAR_API_KEY`, select **HeyGen avatar**, and enter your LiveAvatar ID. The LITE integration uses the existing assistant's ElevenLabs audio, with HeyGen's audio/video feeding Meet's virtual microphone and camera. It does not use Recall.ai. Meeting status, transcript and **Leave meeting** are available in the dashboard.

See [Google Meet setup, login, networking and validation](docs/google-meet.md). Browser automation and the LiveAvatar protocol are implemented and tested against controlled fixtures; actual Google Meet admission and live provider media have **not** been validated in this cloud environment. Its current network policy blocks the required services, and no provider credentials are configured.

## Custom function contract

Set `FUNCTION_ALLOWED_HOSTS` to the exact comma-separated hostnames of function servers. The environment's network settings must also allow them. If a tool needs bearer authentication, set its `secretEnv` to a server-side variable such as `TOOL_CRM_TOKEN`, and provide the value securely. Secret values never go in tool definitions or the UI.

Request:

```json
{
  "message": {
    "type": "tool-calls",
    "timestamp": 123,
    "call": { "id": "CA..." },
    "toolCallList": [
      {
        "id": "call_123",
        "type": "function",
        "function": {
          "name": "lookup_order",
          "arguments": { "orderId": "123" }
        }
      }
    ]
  }
}
```

Response:

```json
{ "results": [{ "toolCallId": "call_123", "result": { "status": "shipped" } }] }
```

Return JSON within the configured timeout and 64 KB limit. Enforce the supplied `Idempotency-Key` server-side. Redirects are not followed. Aborting a call cannot undo a function that has already run.

## Validation

```sh
npm test
npm run typecheck -- --incremental false
npm run build
# After installing Chromium:
npm run test:browser
```

Tests cover opening modes, interruption, playback acknowledgements, tool protocol sequencing, DTMF frequency generation, voicemail/screening decisions, signed webhook routing, persistence, and API failures without credentials. Warm-transfer tests cover private consultation, acceptance verification, conference membership, rejection, ring/consultation/bridge timeouts, late and duplicate callbacks, authenticated recovery, and process restart. Provider doubles do not establish real telephony quality or connectivity. Before live use, validate human answers, natural voicemail, screening, both transfer modes and routing methods, your IVRs, and function success/failure paths on controlled calls.

Meeting tests cover admission, cancellation, login requirements, provider failure/cleanup, custom-function filtering, restart behavior and LiveAvatar LITE messages. Separate Chromium tests exercise virtual microphone/camera streams, incoming-track PCM conversion, playback acknowledgements, avatar isolation and interruption. A local WebRTC transport test is included but skipped when managed Chromium policy blocks direct UDP, as it does in this cloud workspace. Tests do not contact Google or paid providers.
