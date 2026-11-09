"use client";
import { useState } from "react";
import {
  warmTransferSchema,
  toolSchema,
  type ToolInput,
  type ToolConfig,
} from "../../lib/config";
const initial = (type: ToolInput["type"]): ToolInput =>
  type === "transferCall"
    ? {
        type,
        name: "transfer_call",
        description:
          "Transfer the caller to the right team when they request human assistance.",
        transferMode: "blind",
        warmTransfer: warmTransferSchema.parse({}),
        routingMode: "description",
        timeoutSeconds: 30,
        destinations: [
          {
            id: "support",
            number: "",
            description: "Customer support",
            transferPhrase: "",
            message: "I'll transfer you now.",
            extension: "",
          },
        ],
      }
    : type === "dtmf"
      ? {
          type,
          name: "dial_keypad",
          description:
            "Navigate an IVR menu by sending keypad tones. Wait for the full menu before choosing.",
          toneDurationMs: 200,
          gapMs: 100,
        }
      : {
          type,
          name: "custom_function",
          description: "",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          server: { url: "", timeoutSeconds: 15 },
        };
export function ToolEditor({
  existing,
  onSave,
  onCancel,
}: {
  existing?: ToolConfig;
  onSave: (value: ToolInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [tool, setTool] = useState<ToolInput>(
    existing ?? initial("transferCall"),
  );
  const [schema, setSchema] = useState(
    JSON.stringify(
      existing?.type === "function"
        ? existing.parameters
        : {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const parsed = toolSchema.parse(
        tool.type === "function"
          ? { ...tool, parameters: JSON.parse(schema) }
          : tool,
      );
      await onSave(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid tool.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="fields"
    >
      <div className="section-head">
        <h2>{existing ? "Edit tool" : "Create tool"}</h2>
        <button type="button" className="ghost" onClick={onCancel}>
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <label>
        Tool type
        <select
          disabled={!!existing}
          value={tool.type}
          onChange={(e) =>
            setTool(initial(e.target.value as ToolInput["type"]))
          }
        >
          <option value="transferCall">Transfer call</option>
          <option value="dtmf">DTMF / IVR keypad</option>
          <option value="function">Custom function</option>
        </select>
      </label>
      <label>
        Function name
        <input
          value={tool.name}
          onChange={(e) => setTool({ ...tool, name: e.target.value })}
          required
        />
      </label>
      <label>
        Description
        <textarea
          value={tool.description}
          onChange={(e) => setTool({ ...tool, description: e.target.value })}
          required
        />
      </label>
      {tool.type === "transferCall" && (
        <>
          <label>
            Transfer mode
            <select
              value={tool.transferMode}
              onChange={(e) =>
                setTool({
                  ...tool,
                  transferMode: e.target.value as "blind" | "warm",
                })
              }
            >
              <option value="blind">Blind · connect directly</option>
              <option value="warm">
                Warm · agent briefs recipient and confirms acceptance
              </option>
            </select>
          </label>
          {tool.transferMode === "warm" && (
            <fieldset>
              <legend>Warm transfer assistant</legend>
              <p className="hint">
                The caller waits on hold while a separate assistant privately
                briefs the recipient using the conversation so far. It connects
                only after acceptance. The assistant uses your configured
                OpenAI, Deepgram, and ElevenLabs settings.
              </p>
              <label>
                Operator instructions
                <textarea
                  rows={5}
                  value={tool.warmTransfer.operatorPrompt}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        operatorPrompt: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                Operator first message (optional)
                <textarea
                  value={tool.warmTransfer.firstMessage}
                  placeholder="Leave empty to generate a contextual introduction"
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        firstMessage: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <div className="row">
                <label>
                  Consultation limit (seconds)
                  <input
                    type="number"
                    min={30}
                    max={600}
                    value={tool.warmTransfer.maxDurationSeconds}
                    onChange={(e) =>
                      setTool({
                        ...tool,
                        warmTransfer: {
                          ...tool.warmTransfer,
                          maxDurationSeconds: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Recipient silence timeout (seconds)
                  <input
                    type="number"
                    min={10}
                    max={120}
                    value={tool.warmTransfer.silenceTimeoutSeconds}
                    onChange={(e) =>
                      setTool({
                        ...tool,
                        warmTransfer: {
                          ...tool.warmTransfer,
                          silenceTimeoutSeconds: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Connection confirmation timeout (seconds)
                  <input
                    type="number"
                    min={10}
                    max={60}
                    value={tool.warmTransfer.bridgeTimeoutSeconds}
                    onChange={(e) =>
                      setTool({
                        ...tool,
                        warmTransfer: {
                          ...tool.warmTransfer,
                          bridgeTimeoutSeconds: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Message before connecting the parties
                <input
                  value={tool.warmTransfer.connectMessage}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        connectMessage: e.target.value,
                      },
                    })
                  }
                  required
                />
              </label>
              <label>
                Fallback message to caller
                <textarea
                  value={tool.warmTransfer.fallbackMessage}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        fallbackMessage: e.target.value,
                      },
                    })
                  }
                  required
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={tool.warmTransfer.endCallOnFailure}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        endCallOnFailure: e.target.checked,
                      },
                    })
                  }
                />
                End the caller's call after the fallback message
              </label>
              <label>
                Hold audio URL (optional)
                <input
                  type="url"
                  value={tool.warmTransfer.holdAudioUrl ?? ""}
                  placeholder="Use the built-in hold audio, or provide a public HTTPS WAV/MP3 URL"
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      warmTransfer: {
                        ...tool.warmTransfer,
                        holdAudioUrl: e.target.value || undefined,
                      },
                    })
                  }
                />
              </label>
            </fieldset>
          )}
          <label>
            Routing method
            <select
              value={tool.routingMode}
              onChange={(e) =>
                setTool({
                  ...tool,
                  routingMode: e.target.value as "description" | "phrase",
                })
              }
            >
              <option value="description">
                Description · model chooses the destination
              </option>
              <option value="phrase">
                Transfer phrase · caller phrase triggers routing
              </option>
            </select>
          </label>
          <p className="hint">
            The transfer message finishes before dialing. Both warm and blind
            modes support description or phrase routing. Phrase mode matches a
            complete phrase within the caller's final transcript, ignoring
            punctuation and case.
          </p>
          {tool.destinations.map((d, i) => (
            <fieldset key={i}>
              <legend>Destination {i + 1}</legend>
              {(
                [
                  "id",
                  "number",
                  tool.routingMode === "description"
                    ? "description"
                    : "transferPhrase",
                  "message",
                  "extension",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {
                    {
                      id: "Destination ID",
                      number: "Phone number",
                      description: "When to transfer here",
                      transferPhrase: "Caller transfer phrase",
                      message: "Message before transfer (empty = silent)",
                      extension: "Extension / post-answer digits",
                    }[key]
                  }
                  <input
                    value={d[key]}
                    onChange={(e) =>
                      setTool({
                        ...tool,
                        destinations: tool.destinations.map((v, j) =>
                          j === i ? { ...v, [key]: e.target.value } : v,
                        ),
                      })
                    }
                    required={!["message", "extension"].includes(key)}
                  />
                </label>
              ))}
              <button
                className="ghost"
                type="button"
                disabled={tool.destinations.length === 1}
                onClick={() =>
                  setTool({
                    ...tool,
                    destinations: tool.destinations.filter((_, j) => i !== j),
                  })
                }
              >
                Remove destination
              </button>
            </fieldset>
          ))}
          <button
            className="ghost"
            type="button"
            onClick={() =>
              setTool({
                ...tool,
                destinations: [
                  ...tool.destinations,
                  {
                    id: `destination_${tool.destinations.length + 1}`,
                    number: "",
                    description: "",
                    transferPhrase: "",
                    message: "Transferring your call now.",
                    extension: "",
                  },
                ],
              })
            }
          >
            + Add destination
          </button>
          <label>
            Ring timeout (seconds)
            <input
              type="number"
              min={5}
              max={120}
              value={tool.timeoutSeconds}
              onChange={(e) =>
                setTool({ ...tool, timeoutSeconds: Number(e.target.value) })
              }
            />
          </label>
        </>
      )}
      {tool.type === "dtmf" && (
        <>
          <p className="hint">
            Sends in-band keypad audio through Twilio. Supports 0–9, *, #, A–D;
            w pauses 0.5 seconds and W pauses 1 second. Test recognition with
            your target IVR.
          </p>
          <div className="row">
            <label>
              Tone duration (ms)
              <input
                type="number"
                min={100}
                max={1000}
                value={tool.toneDurationMs}
                onChange={(e) =>
                  setTool({ ...tool, toneDurationMs: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Gap between digits (ms)
              <input
                type="number"
                min={50}
                max={1000}
                value={tool.gapMs}
                onChange={(e) =>
                  setTool({ ...tool, gapMs: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </>
      )}
      {tool.type === "function" && (
        <>
          <label>
            Server URL
            <input
              type="url"
              value={tool.server.url}
              onChange={(e) =>
                setTool({
                  ...tool,
                  server: { ...tool.server, url: e.target.value },
                })
              }
              required
              placeholder="https://your-service.com/tools"
            />
          </label>
          <label>
            Parameters · JSON Schema
            <textarea
              className="code"
              rows={12}
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
            />
          </label>
          <div className="row">
            <label>
              Timeout (seconds)
              <input
                type="number"
                min={1}
                max={60}
                value={tool.server.timeoutSeconds}
                onChange={(e) =>
                  setTool({
                    ...tool,
                    server: {
                      ...tool.server,
                      timeoutSeconds: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              Credential variable (optional)
              <input
                placeholder="TOOL_CRM_TOKEN"
                value={tool.server.secretEnv ?? ""}
                onChange={(e) =>
                  setTool({
                    ...tool,
                    server: {
                      ...tool.server,
                      secretEnv: e.target.value || undefined,
                    },
                  })
                }
              />
            </label>
          </div>
          <p className="hint">
            Your server receives a tool-calls webhook and returns results with
            the matching toolCallId. Add its hostname to FUNCTION_ALLOWED_HOSTS.
            Credential values stay on the server.
          </p>
        </>
      )}
      <button disabled={busy} type="submit">
        {busy ? "Saving…" : "Save tool"}
      </button>
    </form>
  );
}
