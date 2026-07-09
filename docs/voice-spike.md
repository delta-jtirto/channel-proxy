# Voice/Video phone spike (Twilio)

Prove the inbound-call path end to end: **guest dials the Twilio number →
Twilio hits our voice webhook → we return TwiML that (a) starts Real-Time
Transcription and (b) dials the browser softphone → the agent's browser
rings**, while transcription events stream to a second webhook.

Serverless-first: Twilio-native Real-Time Transcription delivers the
transcript over webhook POSTs, so there is **no persistent WebSocket and no
new service** — just three ordinary App Router route handlers.

Design doc (AI CS BPO repo): `docs/plans/2026-07-08-voice-video-channel-plan.md`.

## What this spike ships

| Route | Purpose |
| --- | --- |
| `POST /api/proxy/voice/token` | Mint a Twilio AccessToken (VoiceGrant) for the browser softphone. Supabase JWT Bearer auth, same as other `/api/proxy/*` routes. |
| `POST /api/webhooks/twilio/voice` | Twilio's Voice webhook. Verifies the signature, returns TwiML: `<Start><Transcription>` + `<Dial><Client>spike-agent</Client>`. |
| `POST /api/webhooks/twilio/transcription` | Real-Time Transcription status callbacks. Verifies the signature, logs the payload (webhook_logs + console), acks 200. Spike goal: **learn the payload shape**. |

The softphone that registers as `spike-agent` is built later in the BPO repo.
Until then you can still watch the webhooks fire and the transcription events
land — the `<Dial>` simply rings nobody and falls through to the no-answer
`<Say>`.

## Prerequisites

- A Twilio account with a **Voice-capable phone number**.
- Env vars in `.env.local` (never committed — see `.env.example` for the
  names): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`,
  `TWILIO_API_KEY_SECRET`, `TWILIO_PHONE_NUMBER`. Leave
  `TWILIO_TWIML_APP_SID` blank for the inbound-only spike.
- [ngrok](https://ngrok.com) (or any public HTTPS tunnel) to expose the local
  dev server to Twilio.

## Get the Twilio credentials

1. **Account SID** — Twilio Console → **Account Info** (dashboard home). Put
   it in `TWILIO_ACCOUNT_SID`.
2. **Auth Token** — same **Account Info** panel (reveal it). Put it in
   `TWILIO_AUTH_TOKEN`. This is what validates inbound webhook signatures.
3. **API Key** — Console → **Account → API keys & tokens → Create API key**.
   Type **Standard**. Copy the **SID** into `TWILIO_API_KEY_SID` and the
   **Secret** (shown only once) into `TWILIO_API_KEY_SECRET`. This key signs
   the AccessTokens the softphone uses.
4. **Phone number** — Console → **Phone Numbers → Manage → Active numbers**.
   Copy the E.164 number (e.g. `+15551234567`) into `TWILIO_PHONE_NUMBER`.

## Run the spike

```bash
# 1. Start the proxy (Next dev server, default port 3000)
pnpm dev

# 2. In another terminal, tunnel it
ngrok http 3000
#    → note the https forwarding URL, e.g. https://abc123.ngrok-free.app
```

3. **Point the Twilio number's Voice webhook at the tunnel.** Console →
   **Phone Numbers → Manage → Active numbers → (your number) → Voice
   Configuration**:
   - **A call comes in** → **Webhook**
   - URL: `https://<ngrok-host>/api/webhooks/twilio/voice`
   - Method: **HTTP POST**
   - Save.

4. **Call the number from any phone.** Watch the `pnpm dev` terminal:
   - `[twilio-voice] inbound call { callSid, from, to, callStatus }` — the
     voice webhook fired and returned TwiML.
   - `[twilio-transcription] event {...}` lines — Real-Time Transcription
     status callbacks arriving. **This is the payload we're here to learn**;
     the same rows are persisted to `webhook_logs` (channel
     `twilio-transcription`).

   The caller hears ringing (nobody answers yet), then the no-answer
   `<Say>` message, then hangup.

## Outbound / TwiML App (later, not part of this spike)

Browser-originated (outbound) calls need a **TwiML App**:

1. Console → **Voice → TwiML → TwiML Apps → Create new TwiML App**.
2. Set its **Voice Request URL** to your outbound handler (built later).
3. Copy the **TwiML App SID** into `TWILIO_TWIML_APP_SID`.

Once set, `/api/proxy/voice/token` automatically adds
`outgoingApplicationSid` to the VoiceGrant — no code change needed.

## Troubleshooting

- **403 from a webhook** — signature mismatch. Twilio signs against the exact
  URL it called; our routes reconstruct it from `x-forwarded-proto` /
  `x-forwarded-host`. Make sure the Console webhook URL matches the ngrok host
  exactly (https, no trailing slash surprises) and that `TWILIO_AUTH_TOKEN` is
  the current one.
- **No transcription events** — Real-Time Transcription must be enabled on the
  account, and the `<Transcription>` verb needs a reachable
  `statusCallbackUrl` (it's built from the same public origin as the voice
  webhook, so if the voice webhook reaches you, this should too).
- **ngrok URL changed** — the free tier rotates the host each restart;
  re-paste the new URL into the Console.
