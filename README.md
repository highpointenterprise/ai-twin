# AI Twin calling workspace

Modular inbound and outbound calling with **Twilio**, **Deepgram Flux**, **OpenAI**, and **ElevenLabs**. Includes a workspace for assistants, reusable tools, phone-number routing, and call history.

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

Copy `.env.example` to `.env` **only if `.env` does not already exist**, and supply credentials securely. Never commit `.env`.

Required: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PUBLIC_BASE_URL`, and `STREAM_SECRET` (a private random string of at least 32 characters). Set an ElevenLabs voice ID per assistant, or set `ELEVENLABS_VOICE_ID` before the first startup to seed the initial assistant. `TWILIO_PHONE_NUMBER` is an optional outbound fallback.

`PUBLIC_BASE_URL` must be a public HTTPS **origin** forwarded to port 8080, with WebSocket support for `/media`. The README originally suggested `ngrok http 8080`; an installed/authenticated ngrok or another suitable tunnel can supply that origin. Never forward the admin service to the public Internet. Keep `ADMIN_PORT=8081` unless you also update the Next.js rewrite.

Required outbound hosts: `api.twilio.com`, `api.deepgram.com`, `api.openai.com`, and `api.elevenlabs.io`. This cloud environment currently denies those hosts and has no provider credentials, so real calls remain unvalidated.

1. Create/configure an assistant. Set its first-message mode, system prompt, voice, transcriber, speaking plans and call handling.
2. Create reusable tools under **Tools**, then attach them to the assistant.
3. In **Phone numbers**, refresh your Twilio numbers and assign an assistant. Assignment updates that number's Twilio voice webhook.
4. Start a call under **Calls**, or call an assigned number. Inspect the call state, transcript, and tool events.

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

See [warm transfer setup and recovery](docs/warm-transfer.md), [research and parity boundaries](docs/vapi-research.md), and [architecture](docs/architecture.md). This implements the requested initial scope; it is not every Vapi feature. Meet and HeyGen are later integrations.

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
```

Tests cover opening modes, interruption, playback acknowledgements, tool protocol sequencing, DTMF frequency generation, voicemail/screening decisions, signed webhook routing, persistence, and API failures without credentials. Warm-transfer tests cover private consultation, acceptance verification, conference membership, rejection, ring/consultation/bridge timeouts, late and duplicate callbacks, authenticated recovery, and process restart. Provider doubles do not establish real telephony quality or connectivity. Before live use, validate human answers, natural voicemail, screening, both transfer modes and routing methods, your IVRs, and function success/failure paths on controlled calls.
