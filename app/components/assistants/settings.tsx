"use client";
import type { AgentInput } from "@/lib/types";
import type { ToolConfig } from "@/lib/config";
import { VoiceLibrary } from "./voice-library";
export type SettingsPanel =
  "Transcriber" | "Model" | "Voice" | "Tools" | "Advanced";
export function AssistantSettings({
  value: a,
  onChange,
  tools,
  tab,
}: {
  value: AgentInput;
  onChange: (value: AgentInput) => void;
  tools: ToolConfig[];
  tab: SettingsPanel;
}) {
  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]) =>
    onChange({ ...a, [key]: value });
  const number = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
  return (
    <>
      {tab === "Model" && (
        <div className="fields">
          <label>
            Model
            <input
              value={a.model}
              maxLength={128}
              onChange={(e) => set("model", e.target.value)}
              required
              list="assistant-models"
            />
          </label>
          <datalist id="assistant-models">
            <option value="gpt-4.1" />
            <option value="gpt-4.1-mini" />
            <option value="gpt-4o" />
            <option value="gpt-4o-mini" />
          </datalist>
          <p className="hint">
            Use an OpenAI model name, or a provider-prefixed model such as
            openrouter:openai/gpt-4.1. Supported providers: OpenRouter, Groq,
            Cerebras, Together, and custom endpoints. Each provider needs its
            server credentials.
          </p>
          {number(
            "Temperature",
            a.temperature,
            (v) => set("temperature", v),
            0,
            1.2,
            0.1,
          )}
        </div>
      )}
      {tab === "Voice" && (
        <div className="fields">
          <div className="provider">
            <span className="dot" />
            ElevenLabs<span className="subtle">Streaming speech</span>
          </div>
          <label>
            Voice ID
            <input
              value={a.voiceId}
              onChange={(e) => set("voiceId", e.target.value)}
              placeholder="ElevenLabs voice ID, or leave blank for server default"
            />
          </label>
          <VoiceLibrary
            value={a.voiceId}
            onChange={(value) => set("voiceId", value)}
          />
          <label>
            Voice model
            <select
              aria-label="Voice model"
              value={a.voice.model}
              onChange={(e) =>
                set("voice", {
                  ...a.voice,
                  model: e.target.value as AgentInput["voice"]["model"],
                })
              }
            >
              <option>eleven_flash_v2_5</option>
              <option>eleven_turbo_v2_5</option>
              <option>eleven_multilingual_v2</option>
            </select>
          </label>
          <div className="row">
            {number(
              "Stability",
              a.voice.stability,
              (v) => set("voice", { ...a.voice, stability: v }),
              0,
              1,
              0.05,
            )}
            {number(
              "Similarity boost",
              a.voice.similarityBoost,
              (v) => set("voice", { ...a.voice, similarityBoost: v }),
              0,
              1,
              0.05,
            )}
            {number(
              "Speed",
              a.voice.speed,
              (v) => set("voice", { ...a.voice, speed: v }),
              0.7,
              1.2,
              0.05,
            )}
          </div>
        </div>
      )}
      {tab === "Transcriber" && (
        <div className="fields">
          <div className="provider">
            <span className="dot" />
            Deepgram Flux
            <span className="subtle">Transcription + smart endpointing</span>
          </div>
          <label>
            Transcription model
            <select
              aria-label="Transcription model"
              value={a.transcriber.model}
              onChange={(e) =>
                set("transcriber", {
                  ...a.transcriber,
                  model: e.target.value as AgentInput["transcriber"]["model"],
                })
              }
            >
              <option value="flux-general-en">Flux · English</option>
              <option value="flux-general-multi">Flux · Multilingual</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={a.transcriber.eagerEotThreshold !== null}
              onChange={(e) =>
                set("transcriber", {
                  ...a.transcriber,
                  eagerEotThreshold: e.target.checked ? 0.4 : null,
                })
              }
            />
            Enable eager turn detection
          </label>
          {a.transcriber.eagerEotThreshold !== null &&
            number(
              "Eager turn confidence",
              a.transcriber.eagerEotThreshold,
              (v) =>
                set("transcriber", { ...a.transcriber, eagerEotThreshold: v }),
              0.3,
              0.9,
              0.05,
            )}
          <p className="hint">
            Flux detects when a caller has finished speaking. A higher
            confidence threshold waits more conservatively. Its final turn event
            authorizes a response; partial transcripts never execute tools.
          </p>
          <div className="row">
            {number(
              "End-of-turn confidence",
              a.transcriber.eotThreshold,
              (v) => set("transcriber", { ...a.transcriber, eotThreshold: v }),
              0.5,
              0.9,
              0.05,
            )}
            {number(
              "End-of-turn timeout (ms)",
              a.transcriber.eotTimeoutMs,
              (v) => set("transcriber", { ...a.transcriber, eotTimeoutMs: v }),
              500,
              10000,
              100,
            )}
          </div>
        </div>
      )}
      {tab === "Tools" && (
        <div className="fields">
          <h3>Attached tools</h3>
          <p className="hint">
            Create reusable tools in the Tools section, then attach them here.
            Calls use a snapshot of these settings.
          </p>
          {!tools.length && (
            <div className="empty">
              No tools yet. Create a transfer, DTMF, or custom function tool.
            </div>
          )}
          {tools.map((t) => (
            <label className="tool-option" key={t.id}>
              <input
                type="checkbox"
                checked={a.toolIds.includes(t.id)}
                onChange={(e) =>
                  set(
                    "toolIds",
                    e.target.checked
                      ? [...a.toolIds, t.id]
                      : a.toolIds.filter((id) => id !== t.id),
                  )
                }
              />
              <div>
                <strong>{t.name}</strong>
                <span>{t.description}</span>
              </div>
              <small>{t.type}</small>
            </label>
          ))}
        </div>
      )}
      {tab === "Advanced" && (
        <div className="fields">
          <fieldset>
            <legend>Webhook server</legend>
            <label>
              Server URL
              <input
                type="url"
                value={a.server.url}
                maxLength={2048}
                placeholder="https://example.com/webhook"
                onChange={(e) =>
                  set("server", { ...a.server, url: e.target.value })
                }
              />
            </label>
            <p className="hint">
              Receives the End of Call Report as a JSON POST after the call
              recording is processed. Billing may still be reconciling.
              Leave blank to disable. Use a public HTTPS endpoint.
            </p>
            {number(
              "Webhook timeout (seconds)",
              a.server.timeoutSeconds,
              (timeoutSeconds) =>
                set("server", { ...a.server, timeoutSeconds }),
              1,
              300,
            )}
            <p className="hint">
              Temporary delivery failures are retried automatically. Your
              endpoint should acknowledge promptly with a 2xx response and
              deduplicate using the Idempotency-Key header.
            </p>
          </fieldset>
          <fieldset>
            <legend>Start speaking plan</legend>
            <p className="hint">
              Smart endpointing is supplied by Deepgram Flux. This adds a pause
              before the first audio packet of a response.
            </p>
            {number(
              "Wait before speaking (seconds)",
              a.startSpeakingPlan.waitSeconds,
              (v) =>
                set("startSpeakingPlan", {
                  ...a.startSpeakingPlan,
                  waitSeconds: v,
                }),
              0,
              5,
              0.1,
            )}
          </fieldset>
          <fieldset>
            <legend>Stop speaking plan</legend>
            <div className="row">
              {number(
                "Words to interrupt (0 = voice activity)",
                a.stopSpeakingPlan.numWords,
                (v) =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    numWords: v,
                  }),
                0,
                10,
              )}
              {number(
                "Voice duration (seconds)",
                a.stopSpeakingPlan.voiceSeconds,
                (v) =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    voiceSeconds: v,
                  }),
                0.1,
                2,
                0.1,
              )}
              {number(
                "Backoff after interruption (seconds)",
                a.stopSpeakingPlan.backoffSeconds,
                (v) =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    backoffSeconds: v,
                  }),
                0,
                5,
                0.1,
              )}
            </div>
            <label htmlFor="interruption-phrases">
              Interruption phrases (one per line)
              <textarea
                id="interruption-phrases"
                aria-label="Interruption phrases (one per line)"
                value={a.stopSpeakingPlan.interruptionPhrases.join("\n")}
                onChange={(e) =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    interruptionPhrases: e.target.value.split("\n"),
                  })
                }
                onBlur={() =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    interruptionPhrases:
                      a.stopSpeakingPlan.interruptionPhrases.filter((p) =>
                        p.trim(),
                      ),
                  })
                }
              />
            </label>
            <label htmlFor="acknowledgement-phrases">
              Acknowledgement phrases (one per line)
              <textarea
                id="acknowledgement-phrases"
                aria-label="Acknowledgement phrases (one per line)"
                value={a.stopSpeakingPlan.acknowledgementPhrases.join("\n")}
                onChange={(e) =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    acknowledgementPhrases: e.target.value.split("\n"),
                  })
                }
                onBlur={() =>
                  set("stopSpeakingPlan", {
                    ...a.stopSpeakingPlan,
                    acknowledgementPhrases:
                      a.stopSpeakingPlan.acknowledgementPhrases.filter((p) =>
                        p.trim(),
                      ),
                  })
                }
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>Voicemail detection</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={a.voicemailDetection.enabled}
                onChange={(e) =>
                  set("voicemailDetection", {
                    ...a.voicemailDetection,
                    enabled: e.target.checked,
                  })
                }
              />
              Enable Twilio answering-machine detection for outbound calls
            </label>
            {a.voicemailDetection.enabled && (
              <>
                <p className="hint">
                  Detection can delay the opening. Leave-message mode waits for
                  Twilio's end-of-greeting result before playing the message
                  with your ElevenLabs voice.
                </p>
                <label>
                  On voicemail
                  <select
                    aria-label="On voicemail"
                    value={a.voicemailDetection.action}
                    onChange={(e) =>
                      set("voicemailDetection", {
                        ...a.voicemailDetection,
                        action: e.target.value as "hangup" | "leave-message",
                      })
                    }
                  >
                    <option value="hangup">Hang up</option>
                    <option value="leave-message">
                      Leave a message, then hang up
                    </option>
                  </select>
                </label>
                {a.voicemailDetection.action === "leave-message" && (
                  <label htmlFor="voicemail-message">
                    Voicemail message
                    <textarea
                      id="voicemail-message"
                      aria-label="Voicemail message"
                      value={a.voicemailDetection.message}
                      onChange={(e) =>
                        set("voicemailDetection", {
                          ...a.voicemailDetection,
                          message: e.target.value,
                        })
                      }
                      required
                    />
                  </label>
                )}
                {number(
                  "Detection timeout (seconds)",
                  a.voicemailDetection.detectionTimeoutSeconds,
                  (v) =>
                    set("voicemailDetection", {
                      ...a.voicemailDetection,
                      detectionTimeoutSeconds: v,
                    }),
                  3,
                  59,
                )}
                <label>
                  If detection is inconclusive
                  <select
                    aria-label="If detection is inconclusive"
                    value={a.voicemailDetection.unknownAction}
                    onChange={(e) =>
                      set("voicemailDetection", {
                        ...a.voicemailDetection,
                        unknownAction: e.target.value as "continue" | "hangup",
                      })
                    }
                  >
                    <option value="continue">Continue conversation</option>
                    <option value="hangup">Hang up</option>
                  </select>
                </label>
              </>
            )}
          </fieldset>
          <fieldset>
            <legend>Call screening</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={a.callScreening.enabled}
                onChange={(e) =>
                  set("callScreening", {
                    ...a.callScreening,
                    enabled: e.target.checked,
                  })
                }
              />
              Respond to automated name-and-purpose screening
            </label>
            {a.callScreening.enabled && (
              <>
                <p className="hint">
                  Recognizes common English screening prompts and waits for a
                  person. Connecting through every device's screener is not
                  guaranteed. Choose “Assistant waits for user” for screened
                  calls.
                </p>
                <label htmlFor="screening-response">
                  Screening response
                  <textarea
                    id="screening-response"
                    aria-label="Screening response"
                    value={a.callScreening.response}
                    onChange={(e) =>
                      set("callScreening", {
                        ...a.callScreening,
                        response: e.target.value,
                      })
                    }
                    placeholder="This is Luna from Acme, calling about your appointment."
                    required
                  />
                </label>
                {number(
                  "Screening wait (seconds)",
                  a.callScreening.waitSeconds,
                  (v) =>
                    set("callScreening", {
                      ...a.callScreening,
                      waitSeconds: v,
                    }),
                  15,
                  120,
                )}
              </>
            )}
          </fieldset>
          <fieldset>
            <legend>Call timeouts</legend>
            <div className="row">
              {number(
                "Silence timeout (seconds)",
                a.silenceTimeoutSeconds,
                (v) => set("silenceTimeoutSeconds", v),
                10,
                600,
              )}
              {number(
                "Maximum call duration (seconds)",
                a.maxDurationSeconds,
                (v) => set("maxDurationSeconds", v),
                30,
                7200,
              )}
            </div>
          </fieldset>
        </div>
      )}
    </>
  );
}
