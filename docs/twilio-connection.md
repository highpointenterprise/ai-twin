# Connect Twilio from the workspace

1. Open **Phone numbers**.
2. Copy your **Account SID** (`AC…`) and **Auth Token** from the Twilio Console into the form.
3. Choose **Connect & load numbers**. The server checks the credentials by requesting the account's phone numbers. Successful verification saves the connection and immediately displays the numbers, including numbers beyond the first API page.
4. Choose **Make a call** beside a number to preselect its outbound caller ID. To receive calls, select an **Inbound assistant** after configuring the other voice providers and public callback URL.

The Auth Token field clears after a successful connection. On reload, the page shows the connected account but never retrieves its token. Re-enter both credentials to change the account or rotate the token. Invalid credentials, network failures or storage failures leave the previous connection active. An account with no numbers still connects successfully; add a number in Twilio and refresh.

Loading numbers requires Twilio only. AI calls additionally require Deepgram, OpenAI, ElevenLabs, an assistant voice ID, `PUBLIC_BASE_URL` and `STREAM_SECRET`. These remain server configuration. This feature does not purchase numbers or initiate calls when connecting.

## Storage and runtime behavior

`PUT /api/integrations/twilio` is available on the existing loopback admin API, proxied by Next.js. Its JSON body contains `accountSid` and `authToken`. It returns connection metadata, numbers and the names of remaining missing settings. Neither it nor `/api/health` returns the token. The public Twilio webhook service does not expose credential-management endpoints. The form uses a password field and does not store credentials in cookies or browser storage.

The backend encrypts the credentials with AES-256-GCM in `DATA_DIR/twilio-credentials.enc.json`, using a locally generated `DATA_DIR/.credentials.key`. Both files are restricted to the backend user and ignored by Git. Retain both files together across deployments; losing the key makes the saved credentials unreadable. Protect backups and the backend filesystem: someone who can read both files can decrypt the credentials. There is no dependency on a shared hard-coded key or a new manually configured secret.

Saved workspace credentials override `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`; environment values remain a fallback when no workspace credentials have been saved. The normal-call adapter, warm-transfer adapter, webhook signature validator and readiness checks all use the same current credentials without restarting. Changing credentials is blocked while calls, warm transfers or number-assignment updates are active. New call admission is paused while a connection update is being verified.

Number assignments remain stored, but number listings show only numbers owned by the connected account. All outbound caller IDs, including automatic fallbacks, are checked against that account before dialing. If you switch accounts, choose an owned number in Calls or assign a number from the new account to the assistant.

This is still the existing single-user workspace. Keep the admin API on loopback, use HTTPS when accessing the frontend remotely, and put remote access behind your authenticated gateway. This change does not add multi-user login or tenant separation.

## Network access and verification

The backend must reach `api.twilio.com`; for AI calling it must also reach `api.deepgram.com`, `api.openai.com` and `api.elevenlabs.io`. Twilio must reach the public webhook/media origin. Credentials cannot override the cloud environment's network policy. If connecting reports a network error, allow these domains in the environment's network settings and retry with a fresh connection.

Automated tests cover encrypted persistence, restart loading, invalid credentials, secret redaction, cross-origin rejection, live credential changes, webhook validation, active-call protection, number loading, assignments and outbound caller-ID ownership. Browser validation uses an isolated backend with explicitly simulated Twilio responses; it does not establish connectivity to a real Twilio account.
