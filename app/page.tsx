"use client";
import { useCallback, useEffect, useState } from "react";
import {
  assistantSchema,
  type ToolConfig,
  type ToolInput,
} from "../lib/config";
import type { AgentConfig, AgentInput, PhoneNumberView } from "../lib/types";
import { AssistantEditor } from "./components/assistant-editor";
import { ToolEditor } from "./components/tool-editor";
import { CallsPanel } from "./components/calls-panel";
import { api } from "./components/api";
const sections = ["Assistants", "Tools", "Phone numbers", "Calls"] as const;
export default function Page() {
  const [section, setSection] =
      useState<(typeof sections)[number]>("Assistants"),
    [agents, setAgents] = useState<AgentConfig[]>([]),
    [tools, setTools] = useState<ToolConfig[]>([]),
    [numbers, setNumbers] = useState<PhoneNumberView[]>([]);
  const [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<AgentInput | null>(null),
    [toolEdit, setToolEdit] = useState<ToolConfig | "new" | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [missing, setMissing] = useState<string[]>([]),
    [loaded, setLoaded] = useState(false);
  const onError = useCallback((s: string) => setError(s), []);
  const loadNumbers = useCallback(async () => {
    try {
      setNumbers(await api<PhoneNumberView[]>("/numbers"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot load numbers.");
    }
  }, []);
  useEffect(() => {
    void Promise.all([
      api<AgentConfig[]>("/agents"),
      api<ToolConfig[]>("/tools"),
      api<{ missing: string[] }>("/health"),
    ])
      .then(([a, t, h]) => {
        setAgents(a);
        setTools(t);
        setMissing(h.missing);
        setSelected(a[0]?.id ?? "");
        setDraft(a[0] ?? null);
        setLoaded(true);
        if (!h.missing.some((n) => n.startsWith("TWILIO"))) void loadNumbers();
      })
      .catch((e) => setError(e.message));
  }, [loadNumbers]);
  const saveAssistant = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const parsed = assistantSchema.parse(draft);
      const saved = await api<AgentConfig>(
        selected ? `/agents/${selected}` : "/agents",
        selected ? "PUT" : "POST",
        parsed,
      );
      setAgents((a) =>
        selected
          ? a.map((v) => (v.id === selected ? saved : v))
          : [...a, saved],
      );
      setSelected(saved.id);
      setDraft(saved);
      setNotice("Assistant saved. New calls will use these settings.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };
  const saveTool = async (value: ToolInput) => {
    const id = toolEdit && toolEdit !== "new" ? toolEdit.id : undefined;
    const saved = await api<ToolConfig>(
      id ? `/tools/${id}` : "/tools",
      id ? "PUT" : "POST",
      value,
    );
    setTools((t) =>
      id ? t.map((v) => (v.id === id ? saved : v)) : [...t, saved],
    );
    setToolEdit(null);
    setNotice("Tool saved. Attach it to an assistant to use it on calls.");
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AI Twin home">
          <span className="brand-icon">◈</span> AI TWIN
        </a>
        <p className="workspace-label">VOICE WORKSPACE</p>
        <nav>
          {sections.map((s, i) => (
            <button
              key={s}
              className={section === s ? "active" : ""}
              onClick={() => {
                setSection(s);
                setError("");
                setNotice("");
              }}
            >
              <span aria-hidden="true">{["◉", "⌘", "#", "↗"][i]}</span>
              {s}
            </button>
          ))}
        </nav>
        <div className="stack">
          <span className="eyebrow">YOUR CALLING STACK</span>
          {[
            "Twilio · Telephony",
            "Deepgram · Transcriber",
            "ElevenLabs · Voice",
            "OpenAI · Model",
          ].map((p) => (
            <div key={p}>
              <span className="dot" />
              {p}
            </div>
          ))}
        </div>
        <p className="sidebar-footer">
          One conversation engine.
          <br />
          Connected, independent modules.
        </p>
      </aside>
      <div className="workspace">
        <header>
          <span>
            Workspace <span className="slash">/</span> {section}
          </span>
          <span className={missing.length ? "badge pending" : "badge"}>
            {!loaded
              ? "Connecting…"
              : missing.length
                ? "Setup needed for live calls"
                : "Calling configured"}
          </span>
        </header>
        <main>
          <div className="page-title">
            <div>
              <p className="eyebrow">BUILD CONVERSATIONS THAT CONNECT</p>
              <h1>{section}</h1>
              <p className="subtle">
                {section === "Assistants"
                  ? "Define how your assistant listens, speaks, and takes action."
                  : section === "Tools"
                    ? "Build reusable actions and connect them to any assistant."
                    : section === "Phone numbers"
                      ? "Route incoming calls and choose your outbound caller ID."
                      : "Start conversations and inspect what happened."}
              </p>
            </div>
            {section === "Assistants" ? (
              <button
                className="ghost"
                onClick={() => {
                  setSelected("");
                  setDraft(
                    assistantSchema.parse({
                      name: "New assistant",
                      systemPrompt:
                        "You are a helpful voice assistant. Be concise and use attached tools when appropriate.",
                    }),
                  );
                }}
              >
                + New assistant
              </button>
            ) : section === "Tools" ? (
              <button onClick={() => setToolEdit("new")}>+ Create tool</button>
            ) : null}
          </div>
          {error && (
            <div role="alert" className="notice error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice success">
              {notice}
            </div>
          )}
          {missing.length > 0 && (
            <details className="setup">
              <summary>
                Configure provider credentials to enable live calling
              </summary>
              <p>
                You can create assistants and tools now. Missing configuration:
              </p>
              <ul>
                {missing.map((n) => (
                  <li key={n}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
              <p>
                Set credentials securely on the server, then restart it. Each
                assistant also needs an ElevenLabs voice ID.
              </p>
            </details>
          )}
          {!loaded && !error && (
            <div className="empty">Loading your workspace…</div>
          )}
          {section === "Assistants" && (
            <div className="assistant-layout">
              <div className="assistant-list">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    className={selected === a.id ? "selected" : ""}
                    onClick={() => {
                      setSelected(a.id);
                      setDraft(a);
                    }}
                  >
                    <span className="avatar">{a.name.charAt(0)}</span>
                    <span>
                      <strong>{a.name}</strong>
                      <small>
                        {a.toolIds.length} tools · {a.model}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <section className="editor">
                {draft && (
                  <AssistantEditor
                    key={selected || "new"}
                    value={draft}
                    onChange={setDraft}
                    tools={tools}
                    onSave={() => void saveAssistant()}
                    busy={saving}
                  />
                )}
              </section>
            </div>
          )}
          {section === "Tools" &&
            (toolEdit ? (
              <section className="editor">
                <ToolEditor
                  key={toolEdit === "new" ? "new" : toolEdit.id}
                  existing={toolEdit === "new" ? undefined : toolEdit}
                  onSave={saveTool}
                  onCancel={() => setToolEdit(null)}
                />
              </section>
            ) : (
              <div className="tool-grid">
                {tools.length ? (
                  tools.map((t) => (
                    <section className="tool-card" key={t.id}>
                      <span className="badge">
                        {t.type === "transferCall"
                          ? "Transfer call"
                          : t.type === "dtmf"
                            ? "DTMF / IVR"
                            : "Custom function"}
                      </span>
                      <h2>{t.name}</h2>
                      <p>{t.description}</p>
                      <div className="row">
                        <button
                          className="ghost"
                          onClick={() => setToolEdit(t)}
                        >
                          Edit tool
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void api(`/tools/${t.id}`, "DELETE")
                              .then(() =>
                                setTools((ts) =>
                                  ts.filter((v) => v.id !== t.id),
                                ),
                              )
                              .catch((e) => setError(e.message))
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </section>
                  ))
                ) : (
                  <section className="empty">
                    <h2>Give your assistants the tools to act.</h2>
                    <p>
                      Create transfers, navigate IVRs, or connect your own
                      functions.
                    </p>
                    <button onClick={() => setToolEdit("new")}>
                      Create your first tool
                    </button>
                  </section>
                )}
              </div>
            ))}
          {section === "Phone numbers" && (
            <section>
              <div className="section-head">
                <h2>Your Twilio numbers</h2>
                <button className="ghost" onClick={() => void loadNumbers()}>
                  Refresh numbers
                </button>
              </div>
              <p className="hint">
                Assigning an assistant updates the number's Twilio voice
                webhook. These numbers can also be used for outbound calls.
              </p>
              {!numbers.length ? (
                <div className="empty">
                  Connect your Twilio account, then refresh to load numbers.
                </div>
              ) : (
                numbers.map((n) => (
                  <div className="number-row" key={n.sid}>
                    <div>
                      <strong>{n.phoneNumber}</strong>
                      <small>{n.label}</small>
                    </div>
                    <label>
                      Inbound assistant
                      <select
                        value={n.agentId ?? ""}
                        onChange={(e) => {
                          if (e.target.value)
                            void api(`/numbers/${n.sid}/assign`, "POST", {
                              agentId: e.target.value,
                            })
                              .then(() => loadNumbers())
                              .catch((e) => setError(e.message));
                        }}
                      >
                        <option value="" disabled>
                          Choose assistant
                        </option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))
              )}
            </section>
          )}
          {section === "Calls" && (
            <CallsPanel agents={agents} numbers={numbers} onError={onError} />
          )}
        </main>
        <footer>AI Twin · Voice calling workspace</footer>
      </div>
    </div>
  );
}
