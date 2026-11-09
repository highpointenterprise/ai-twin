"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { MeetingsPanel } from "./components/meetings-panel";
import { DiagnosticsPanel } from "./components/diagnostics-panel";
import { Button } from "../components/ui/button";
import { TwilioConnection } from "./components/twilio-connection";
import type {
  TwilioConnectionResult,
  TwilioConnectionStatus,
} from "../lib/twilio";
const sections = [
  "Meetings",
  "Assistants",
  "Tools",
  "Phone numbers",
  "Calls",
  "Diagnostics",
] as const;
export default function Page() {
  const [section, setSection] = useState<(typeof sections)[number]>("Meetings"),
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
  const [twilio, setTwilio] = useState<TwilioConnectionStatus | null>(null);
  const [loadingNumbers, setLoadingNumbers] = useState(false);
  const [preferredFrom, setPreferredFrom] = useState("");
  const numbersRequest = useRef(0);
  const onError = useCallback((s: string) => setError(s), []);
  const loadNumbers = useCallback(async () => {
    const request = ++numbersRequest.current;
    setLoadingNumbers(true);
    setError("");
    try {
      const numbers = await api<PhoneNumberView[]>("/numbers");
      if (request === numbersRequest.current) setNumbers(numbers);
    } catch (e) {
      if (request === numbersRequest.current)
        setError(e instanceof Error ? e.message : "Cannot load numbers.");
    } finally {
      if (request === numbersRequest.current) setLoadingNumbers(false);
    }
  }, []);
  const connected = (result: TwilioConnectionResult) => {
    numbersRequest.current++;
    setLoadingNumbers(false);
    setNumbers(result.numbers);
    setTwilio(result.connection);
    setMissing(result.missing);
    setPreferredFrom("");
    setError("");
    setNotice(
      `Twilio connected. ${result.numbers.length} phone ${result.numbers.length === 1 ? "number" : "numbers"} loaded.`,
    );
  };
  useEffect(() => {
    void Promise.all([
      api<AgentConfig[]>("/agents"),
      api<ToolConfig[]>("/tools"),
      api<{ missing: string[]; twilio: TwilioConnectionStatus }>("/health"),
    ])
      .then(([a, t, h]) => {
        setAgents(a);
        setTools(t);
        setMissing(h.missing);
        setTwilio(h.twilio);
        setSelected(a[0]?.id ?? "");
        setDraft(a[0] ?? null);
        setLoaded(true);
        if (h.twilio.configured) void loadNumbers();
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
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">AI Twin</h1>
        <nav className="flex flex-wrap gap-2" aria-label="Dashboard">
          {sections.map((s) => (
            <Button
              key={s}
              variant={section === s ? "default" : "outline"}
              onClick={() => {
                setSection(s);
                setError("");
                setNotice("");
              }}
            >
              {s}
            </Button>
          ))}
        </nav>
      </header>
      <main className="space-y-4">
        <div className="section-head">
          <h2>{section}</h2>
          {section === "Assistants" ? (
            <Button
              variant="outline"
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
            </Button>
          ) : section === "Tools" ? (
            <Button onClick={() => setToolEdit("new")}>+ Create tool</Button>
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
        {section !== "Meetings" &&
          section !== "Diagnostics" &&
          missing.length > 0 && (
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
                Connect Twilio in Phone numbers. Set the remaining provider
                credentials and public callback URL on the server, then restart
                it. Each assistant also needs an ElevenLabs voice ID.
              </p>
            </details>
          )}
        {!loaded && !error && (
          <div className="empty">Loading your workspace…</div>
        )}
        {section === "Meetings" && loaded && <MeetingsPanel agents={agents} />}
        {section === "Diagnostics" && <DiagnosticsPanel />}
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
                        ? t.transferMode === "warm"
                          ? "Warm transfer"
                          : "Blind transfer"
                        : t.type === "dtmf"
                          ? "DTMF / IVR"
                          : "Custom function"}
                    </span>
                    <h2>{t.name}</h2>
                    <p>{t.description}</p>
                    <div className="row">
                      <button className="ghost" onClick={() => setToolEdit(t)}>
                        Edit tool
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          void api(`/tools/${t.id}`, "DELETE")
                            .then(() =>
                              setTools((ts) => ts.filter((v) => v.id !== t.id)),
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
          <div className="fields">
            {loaded && (
              <TwilioConnection
                key={twilio?.accountSid ?? "new"}
                connection={twilio}
                onConnected={connected}
              />
            )}
            <section>
              <div className="section-head">
                <h2>Your Twilio numbers</h2>
                <button
                  className="ghost"
                  disabled={!twilio?.configured || loadingNumbers}
                  onClick={() => void loadNumbers()}
                >
                  {loadingNumbers ? "Loading numbers…" : "Refresh numbers"}
                </button>
              </div>
              <p className="hint">
                Assigning an assistant updates the number's Twilio voice
                webhook. These numbers can also be used for outbound calls.
              </p>
              {!numbers.length ? (
                <div className="empty">
                  {loadingNumbers
                    ? "Loading your Twilio phone numbers…"
                    : twilio?.configured
                      ? "No phone numbers found. Add a number in your Twilio Console, then refresh."
                      : "Connect your Twilio account above to load its phone numbers."}
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
                    {n.agentId && (
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() => {
                          setSaving(true);
                          setError("");
                          void api(`/numbers/${n.sid}/assign`, "POST", {
                            agentId: n.agentId,
                          })
                            .then(() =>
                              setNotice(
                                "Inbound route updated to the current public URL.",
                              ),
                            )
                            .catch((e) => setError(e.message))
                            .finally(() => setSaving(false));
                        }}
                      >
                        Refresh inbound route
                      </Button>
                    )}
                    <button
                      className="ghost"
                      onClick={() => {
                        setPreferredFrom(n.phoneNumber);
                        setSection("Calls");
                        setError("");
                        setNotice("");
                      }}
                    >
                      Make a call
                    </button>
                  </div>
                ))
              )}
            </section>
          </div>
        )}
        {section === "Calls" && (
          <CallsPanel
            agents={agents}
            numbers={numbers}
            onError={onError}
            initialFrom={preferredFrom}
          />
        )}
      </main>
    </div>
  );
}
