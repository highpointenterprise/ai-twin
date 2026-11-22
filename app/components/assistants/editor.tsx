"use client";
import { useState } from "react";
import type { AgentInput } from "@/lib/types";
import type { ToolConfig } from "@/lib/config";
import { AssistantSettings, type SettingsPanel } from "./settings";
import { SettingsDrawer } from "./settings-drawer";
import { SummaryCard } from "./summary-card";
export function AssistantEditor({
  value: a,
  onChange,
  tools,
  onSave,
  busy,
  dirty,
  id,
  onDiscard,
}: {
  value: AgentInput;
  onChange: (a: AgentInput) => void;
  tools: ToolConfig[];
  onSave: () => void;
  busy: boolean;
  dirty: boolean;
  id?: string;
  onDiscard: () => void;
}) {
  const [view, setView] = useState<"Assistant" | "Tools" | "Advanced">(
    "Assistant",
  );
  const [panel, setPanel] = useState<SettingsPanel | null>(null);
  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]) =>
    onChange({ ...a, [key]: value });
  return (
    <form
      className="assistant-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setPanel(null);
        onSave();
      }}
    >
      <header className="assistant-editor-header">
        <div>
          <h1>{a.name || "New assistant"}</h1>
          <p>{id ? (dirty ? "Unsaved changes" : "Saved") : "New draft"}</p>
        </div>
        <div className="editor-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy || !dirty}
            onClick={onDiscard}
          >
            Discard changes
          </button>
          <button type="submit" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save assistant"}
          </button>
        </div>
      </header>
      <nav className="assistant-subnav" aria-label="Assistant configuration">
        {(["Assistant", "Tools", "Advanced"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-current={view === item ? "page" : undefined}
            onClick={() => setView(item)}
          >
            {item}
            {item === "Tools" ? ` (${a.toolIds.length})` : ""}
          </button>
        ))}
      </nav>
      <fieldset className="assistant-content" disabled={busy}>
        {view === "Assistant" ? (
          <>
            <div className="assistant-summaries">
              <SummaryCard
                title="Transcriber"
                value={
                  a.transcriber.model === "flux-general-multi"
                    ? "Flux Multilingual"
                    : "Flux English"
                }
                detail="Deepgram · Smart endpointing"
                onEdit={() => setPanel("Transcriber")}
              />
              <SummaryCard
                title="Model"
                value={a.model}
                detail={`Temperature · ${a.temperature}`}
                onEdit={() => setPanel("Model")}
              />
              <SummaryCard
                title="Voice"
                value={a.voiceId || "Choose a voice"}
                detail={`ElevenLabs · ${a.voice.model.replaceAll("_", " ")}`}
                onEdit={() => setPanel("Voice")}
              />
            </div>
            <section className="assistant-card">
              <label>
                Assistant name
                <input
                  value={a.name}
                  onChange={(e) => set("name", e.target.value)}
                  required
                  maxLength={60}
                  placeholder="Name your assistant"
                />
              </label>
            </section>
            <section className="assistant-card">
              <label>
                System prompt
                <textarea
                  id="assistant-prompt"
                  aria-label="System prompt"
                  rows={10}
                  value={a.systemPrompt}
                  onChange={(e) => set("systemPrompt", e.target.value)}
                  required
                  maxLength={16000}
                  placeholder="Describe your assistant’s role, goals, and how it should use its tools."
                />
              </label>
              <p className="field-footer">
                {a.systemPrompt.length.toLocaleString()} / 16,000 characters
              </p>
            </section>
            <section className="assistant-card">
              <label>
                First message mode
                <select
                  aria-label="First message mode"
                  value={a.firstMessageMode}
                  onChange={(e) =>
                    set(
                      "firstMessageMode",
                      e.target.value as AgentInput["firstMessageMode"],
                    )
                  }
                >
                  <option value="assistant-speaks-first">
                    Assistant speaks first
                  </option>
                  <option value="assistant-waits-for-user">
                    Assistant waits for user
                  </option>
                  <option value="assistant-speaks-first-with-model-generated-message">
                    Model-generated first message
                  </option>
                </select>
              </label>
              {a.firstMessageMode === "assistant-speaks-first" ? (
                <label>
                  First message
                  <textarea
                    id="assistant-first-message"
                    aria-label="First message"
                    rows={3}
                    required
                    maxLength={1500}
                    value={a.firstMessage}
                    onChange={(e) => set("firstMessage", e.target.value)}
                  />
                </label>
              ) : (
                <p className="hint">
                  {a.firstMessageMode === "assistant-waits-for-user"
                    ? "Listen until the caller finishes their first turn."
                    : "Generate the opening using the system prompt and call context."}
                </p>
              )}
            </section>
          </>
        ) : (
          <div className="assistant-card">
            <AssistantSettings
              value={a}
              onChange={onChange}
              tools={tools}
              tab={view}
            />
          </div>
        )}
      </fieldset>
      {panel && (
        <SettingsDrawer title={panel} onClose={() => setPanel(null)}>
          <AssistantSettings
            value={a}
            onChange={onChange}
            tools={tools}
            tab={panel}
          />
        </SettingsDrawer>
      )}
    </form>
  );
}
