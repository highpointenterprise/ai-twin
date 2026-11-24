"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ToolConfig, type ToolInput } from "@/lib/config";
import type { AgentConfig, PhoneNumberView } from "@/lib/types";
import { AssistantsWorkspace } from "@/app/components/assistants/workspace";
import { LogoutButton } from "@/app/components/logout-button";
import { ToolEditor } from "@/app/components/tool-editor";
import { AccountSettings } from "@/app/components/account-settings";
import { ApiKeysPanel } from "@/app/components/api-keys-panel";
import { CopyValue } from "@/app/components/copy-value";
import { BillingPanel } from "@/app/components/billing-panel";
import { CallsPanel } from "@/app/components/calls-panel";
import { api, apiList } from "@/app/components/api";
import { MeetingsPanel } from "@/app/components/meetings-panel";
import { DiagnosticsPanel } from "@/app/components/diagnostics-panel";
import { Button } from "@/components/ui/button";
import { PhoneNumbersPanel } from "@/app/components/phone-numbers/panel";
import type {
  TwilioConnectionResult,
  TwilioConnectionStatus,
} from "@/lib/twilio";
const sections = [
  "Meetings",
  "Assistants",
  "Tools",
  "Phone numbers",
  "Calls",
  "Usage & costs",
  "API keys",
  "Diagnostics",
  "Account settings",
] as const;
export default function Page({
  user,
}: {
  user: { id: string; name: string; email: string };
}) {
  const [accountUser, setAccountUser] = useState(user);
  const leaveGuard = useRef<() => boolean>(() => true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [section, setSection] =
      useState<(typeof sections)[number]>("Assistants"),
    [agents, setAgents] = useState<AgentConfig[]>([]),
    [tools, setTools] = useState<ToolConfig[]>([]),
    [numbers, setNumbers] = useState<PhoneNumberView[]>([]);
  const [toolEdit, setToolEdit] = useState<ToolConfig | "new" | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
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
    let cancelled = false;
    void Promise.all([
      apiList<AgentConfig>("/agents"),
      apiList<ToolConfig>("/tools"),
      api<{ missing: string[]; twilio: TwilioConnectionStatus }>("/health"),
    ])
      .then(([a, t, h]) => {
        if (cancelled) return;
        setAgents(a);
        setTools(t);
        setMissing(h.missing);
        setTwilio(h.twilio);
        setLoaded(true);
        if (h.twilio.configured) void loadNumbers();
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [loadNumbers, loadVersion]);
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
    <div className="dashboard-shell">
      <aside className="workspace-nav">
        <div className="workspace-brand">
          <span aria-hidden="true">✦</span> AI Twin
        </div>
        <div className="workspace-account">
          <strong>{accountUser.name}</strong>
          <span>{accountUser.email}</span>
          <CopyValue label="Workspace / User ID" value={user.id} />
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Dashboard">
          {sections.map((s) => (
            <button
              type="button"
              key={s}
              aria-current={section === s ? "page" : undefined}
              onClick={() => {
                if (s === section || !leaveGuard.current()) return;
                setSection(s);
                setError("");
                setNotice("");
              }}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="workspace-signout">
          <LogoutButton />
        </div>
      </aside>
      <main
        className={
          section === "Assistants"
            ? "workspace-main"
            : "workspace-main legacy-content"
        }
      >
        {section === "Assistants" ? (
          <AssistantsWorkspace
            agents={agents}
            tools={tools}
            loaded={loaded}
            error={error}
            missing={missing}
            leaveGuard={leaveGuard}
            onRetry={() => {
              setError("");
              setLoadVersion((v) => v + 1);
            }}
            onSaved={(saved) =>
              setAgents((current) =>
                current.some((a) => a.id === saved.id)
                  ? current.map((a) => (a.id === saved.id ? saved : a))
                  : [...current, saved],
              )
            }
          />
        ) : (
          <>
            <div className="section-head">
              <h2>{section}</h2>
              {section === "Tools" && (
                <Button onClick={() => setToolEdit("new")}>
                  + Create tool
                </Button>
              )}
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
              section !== "Diagnostics" && section !== "Account settings" &&
              missing.length > 0 && (
                <details className="setup">
                  <summary>
                    Configure provider credentials to enable live calling
                  </summary>
                  <p>
                    You can create assistants and tools now. Missing
                    configuration:
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
                    credentials and public callback URL on the server, then
                    restart it. Each assistant also needs an ElevenLabs voice
                    ID.
                  </p>
                </details>
              )}
            {!loaded && !error && section !== "Account settings" && (
              <div className="empty">Loading your workspace…</div>
            )}
            {section === "Meetings" && loaded && (
              <MeetingsPanel agents={agents} />
            )}
            {section === "Account settings" && <AccountSettings onUser={setAccountUser} />}
            {section === "Diagnostics" && <DiagnosticsPanel />}
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
            {section === "Phone numbers" && loaded && (
              <PhoneNumbersPanel
                key={twilio?.accountSid ?? "new"}
                connection={twilio}
                numbers={numbers}
                agents={agents}
                loading={loadingNumbers}
                onConnected={connected}
                onRefresh={loadNumbers}
                onNumbers={setNumbers}
                onCall={(number) => {
                  setPreferredFrom(number);
                  setSection("Calls");
                  setError("");
                  setNotice("");
                }}
              />
            )}
            {section === "API keys" && <ApiKeysPanel userId={user.id} agents={agents} numbers={numbers} />}
            {section === "Usage & costs" && <BillingPanel />}
            {section === "Calls" && (
              <CallsPanel
                agents={agents}
                numbers={numbers}
                onError={onError}
                initialFrom={preferredFrom}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
