"use client";
import { useEffect, useState, type MutableRefObject } from "react";
import type { AgentConfig } from "@/lib/types";
import type { ToolConfig } from "@/lib/config";
import { AssistantEditor } from "./editor";
import { useAssistantDraft } from "./use-assistant-draft";
export function AssistantsWorkspace({
  agents,
  tools,
  loaded,
  error,
  onRetry,
  onSaved,
  leaveGuard,
  missing,
}: {
  agents: AgentConfig[];
  tools: ToolConfig[];
  loaded: boolean;
  error: string;
  onRetry: () => void;
  onSaved: (agent: AgentConfig) => void;
  leaveGuard: MutableRefObject<() => boolean>;
  missing: string[];
}) {
  const state = useAssistantDraft(agents, onSaved);
  const [search, setSearch] = useState("");
  useEffect(() => {
    leaveGuard.current = state.canLeave;
    return () => {
      leaveGuard.current = () => true;
    };
  }, [leaveGuard, state.canLeave]);
  const filtered = agents.filter((agent) =>
    `${agent.name} ${agent.model}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="assistants-workspace">
      <aside className="assistants-browser" aria-label="Assistant list">
        <header>
          <h2>
            Assistants <span>{agents.length}</span>
          </h2>
        </header>
        <div className="assistant-list-controls">
          <button
            type="button"
            disabled={!loaded || state.busy}
            onClick={() => {
              state.select();
              setSearch("");
            }}
          >
            + Create assistant
          </button>
          <label className="assistant-search">
            <span className="sr-only">Search assistants</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assistants…"
            />
          </label>
        </div>
        <div className="assistant-results">
          {filtered.map((agent) => (
            <button
              type="button"
              key={agent.id}
              disabled={state.busy}
              aria-pressed={state.selected === agent.id}
              className="assistant-list-item"
              onClick={() => state.select(agent)}
            >
              <strong>{agent.name}</strong>
              <small>
                {agent.transcriber.model === "flux-general-multi"
                  ? "Flux Multilingual"
                  : "Flux English"}{" "}
                · {agent.model}
              </small>
            </button>
          ))}
          {loaded && !filtered.length && (
            <p className="list-empty">
              {search
                ? "No matching assistants."
                : "Your assistants will appear here."}
            </p>
          )}
        </div>
      </aside>
      <div className="assistant-stage">
        {(state.error || error) && (
          <div role="alert" className="error assistant-feedback">
            {state.error || error}
            {!loaded && (
              <button type="button" onClick={onRetry}>
                Retry loading
              </button>
            )}
          </div>
        )}
        {state.notice && (
          <div role="status" className="notice success assistant-feedback">
            {state.notice}
          </div>
        )}
        {!loaded ? (
          <div className="assistant-empty" role="status">
            {error
              ? "Unable to load your assistants."
              : "Loading your assistants…"}
          </div>
        ) : state.draft ? (
          <AssistantEditor
            key={state.selected || "new"}
            value={state.draft}
            onChange={state.setDraft}
            tools={tools}
            onSave={() => void state.save()}
            busy={state.busy}
            dirty={state.dirty}
            id={state.selected}
            onDiscard={state.discard}
          />
        ) : (
          <div className="assistant-empty">
            <span className="empty-mark" aria-hidden="true">
              ✦
            </span>
            <h1>Create your first assistant</h1>
            <p>
              Choose a transcriber, model, and voice. Then give your assistant
              its instructions.
            </p>
            <button type="button" onClick={() => state.select()}>
              Create assistant
            </button>
          </div>
        )}
        {missing.length > 0 && loaded && (
          <details className="assistant-setup">
            <summary>Live calling setup</summary>
            <p>
              Assistant settings can be saved now. Live calls need:{" "}
              {missing.join(", ")}. Connect Twilio in Phone numbers and
              configure the remaining providers on the backend.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
