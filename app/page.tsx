"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AgentConfig, AgentInput, CallRecord, CallTraceView, ConversationMode, PhoneNumberView, VoiceOption } from "../lib/types";

const api = async <T,>(path: string, init?: { method: string; body: unknown }): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? "Request failed.");
  return body as T;
};

const STATUS_LABEL: Record<CallRecord["status"], string> = {
  initiating: "Initiating",
  ringing: "Ringing",
  connected: "Connected",
  "in-progress": "In progress",
  completed: "Completed",
  failed: "Failed",
};

const REALTIME_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];

const MODES: { value: ConversationMode; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "Deepgram, OpenAI and ElevenLabs. Turn-based with barge-in. Lowest cost." },
  { value: "full-duplex", label: "Full duplex", hint: "OpenAI speech-to-speech. Listens while speaking, so it handles overlap naturally. Higher cost per minute." },
];

const toInput = ({ id: _id, ...rest }: AgentConfig): AgentInput => rest;
const isDone = (call: CallRecord): boolean => call.status === "completed" || call.status === "failed";

export default function Page() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumberView[]>([]);
  const [numberSid, setNumberSid] = useState("");
  const [to, setTo] = useState("");
  const [context, setContext] = useState("");
  const [minutes, setMinutes] = useState("");
  const [call, setCall] = useState<CallRecord | null>(null);
  const [trace, setTrace] = useState<CallTraceView | null>(null);
  const [notice, setNotice] = useState("");

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      setNotice("");
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    }
  }, []);

  const select = (list: AgentConfig[], id: string): void => {
    setAgentId(id);
    const agent = list.find((candidate) => candidate.id === id);
    setDraft(agent ? toInput(agent) : null);
  };

  const loadNumbers = useCallback(() => run(async () => setNumbers(await api<PhoneNumberView[]>("/numbers"))), [run]);

  useEffect(() => {
    void run(async () => {
      const list = await api<AgentConfig[]>("/agents");
      setAgents(list);
      select(list, list[0]?.id ?? "");
    });
    void api<VoiceOption[]>("/voices").then(setVoices).catch(() => undefined);
    void loadNumbers();
  }, [run, loadNumbers]);

  useEffect(() => {
    if (!call) return;
    const loadTrace = (): void => {
      api<CallTraceView>(`/calls/${call.sid}/trace`).then(setTrace).catch(() => undefined);
    };
    if (isDone(call)) {
      const timer = setTimeout(loadTrace, 1200);
      return () => clearTimeout(timer);
    }
    const timer = setInterval(() => {
      api<CallRecord>(`/calls/${call.sid}`).then(setCall).catch(() => undefined);
      loadTrace();
    }, 1500);
    return () => clearInterval(timer);
  }, [call]);

  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]): void =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const saveAgent = (event: FormEvent): void => {
    event.preventDefault();
    if (!draft) return;
    void run(async () => {
      const saved = await api<AgentConfig>(`/agents/${agentId}`, { method: "PUT", body: draft });
      setAgents(agents.map((agent) => (agent.id === saved.id ? saved : agent)));
      setNotice("Agent saved. New calls will use these settings.");
    });
  };

  const duplicateAgent = (): void =>
    void run(async () => {
      if (!draft) return;
      const created = await api<AgentConfig>("/agents", { method: "POST", body: { ...draft, name: `${draft.name} copy` } });
      const list = [...agents, created];
      setAgents(list);
      select(list, created.id);
    });

  const assign = (): void =>
    void run(async () => {
      await api<PhoneNumberView>(`/numbers/${numberSid}/assign`, { method: "POST", body: { agentId } });
      await loadNumbers();
      setNotice("Number assigned. Incoming calls now reach this agent.");
    });

  const startCall = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      setTrace(null);
      const body = {
        agentId,
        to: to.trim(),
        context: context.trim() || undefined,
        plannedMinutes: minutes ? Number(minutes) : undefined,
      };
      setCall(await api<CallRecord>("/calls", { method: "POST", body }));
    });
  };

  const agentName = (id: string | null): string => agents.find((agent) => agent.id === id)?.name ?? "Unassigned";

  return (
    <main>
      <h1>Voice agent console</h1>
      <p className="lede">Configure an agent, route a number to it, then place or receive calls.</p>
      {notice && <p role="status" className="notice">{notice}</p>}

      <section>
        <h2>Agent</h2>
        <div className="row">
          <select aria-label="Agent" value={agentId} onChange={(event) => select(agents, event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <button type="button" className="ghost" onClick={duplicateAgent}>Duplicate</button>
        </div>
        {draft && (
          <form onSubmit={saveAgent}>
            <fieldset>
              <legend>Conversation mode</legend>
              <div className="segmented">
                {MODES.map((mode) => (
                  <label key={mode.value} className={draft.mode === mode.value ? "on" : ""}>
                    <input type="radio" name="mode" checked={draft.mode === mode.value} onChange={() => set("mode", mode.value)} />
                    {mode.label}
                  </label>
                ))}
              </div>
              <small>{MODES.find((mode) => mode.value === draft.mode)?.hint}</small>
            </fieldset>
            <label>Name<input value={draft.name} onChange={(event) => set("name", event.target.value)} required /></label>
            <label>Opening message<input value={draft.greeting} onChange={(event) => set("greeting", event.target.value)} required /></label>
            <label>System prompt<textarea rows={7} value={draft.systemPrompt} onChange={(event) => set("systemPrompt", event.target.value)} required /></label>
            {draft.mode === "standard" ? (
              <label>Voice (ElevenLabs)
                {voices.length > 0 ? (
                  <select value={draft.voiceId} onChange={(event) => set("voiceId", event.target.value)}>
                    {!voices.some((voice) => voice.id === draft.voiceId) && <option value={draft.voiceId}>{draft.voiceId}</option>}
                    {voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>{voice.name}</option>
                    ))}
                  </select>
                ) : (
                  <input value={draft.voiceId} onChange={(event) => set("voiceId", event.target.value)} required />
                )}
              </label>
            ) : (
              <label>Voice (OpenAI)
                <select value={draft.realtimeVoice} onChange={(event) => set("realtimeVoice", event.target.value)}>
                  {REALTIME_VOICES.map((voice) => (
                    <option key={voice} value={voice}>{voice}</option>
                  ))}
                </select>
              </label>
            )}
            {draft.mode === "standard" && (
              <div className="row">
                <label>Model<input value={draft.model} onChange={(event) => set("model", event.target.value)} required /></label>
                <label>Temperature<input type="number" min={0} max={1.2} step={0.1} value={draft.temperature} onChange={(event) => set("temperature", Number(event.target.value))} /></label>
              </div>
            )}
            <button type="submit">Save agent</button>
          </form>
        )}
      </section>

      <section>
        <h2>Phone number</h2>
        <ul className="numbers">
          {numbers.map((number) => (
            <li key={number.sid}>
              <label className="radio">
                <input type="radio" name="number" checked={numberSid === number.sid} onChange={() => setNumberSid(number.sid)} />
                <span>{number.phoneNumber}</span>
                <small>{agentName(number.agentId)}</small>
              </label>
            </li>
          ))}
          {numbers.length === 0 && <li className="note">No Twilio numbers found.</li>}
        </ul>
        <button type="button" onClick={assign} disabled={!numberSid || !agentId}>Assign number to this agent</button>
      </section>

      <section>
        <h2>Outbound call</h2>
        <form onSubmit={startCall}>
          <label>Destination<input type="tel" placeholder="+14155550123" value={to} onChange={(event) => setTo(event.target.value)} required /></label>
          <label>What should the agent talk about? (optional)
            <textarea rows={3} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Goal of the call, who they are, key facts to cover." />
          </label>
          <label>Planned length in minutes (optional)
            <input type="number" min={1} max={120} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          </label>
          <button type="submit" disabled={!agentId}>Call now</button>
        </form>
        {call && <p role="status" className={`status ${call.status}`}>{STATUS_LABEL[call.status]}</p>}
      </section>

      {trace && (
        <section>
          <h2>Call log</h2>
          <p className="stats">
            {trace.stats.turns} timed turns · average {trace.stats.avgLatencyMs} ms · median {trace.stats.p50LatencyMs} ms · slowest {trace.stats.maxLatencyMs} ms
          </p>
          <ol className="transcript">
            {trace.transcript.map((line, index) => (
              <li key={index} className={line.role}>
                <b>{line.role === "agent" ? "Agent" : "Caller"}</b> {line.text}
                {line.latencyMs !== undefined && <span className="chip">{line.latencyMs} ms</span>}
              </li>
            ))}
          </ol>
          <details>
            <summary>Event log ({trace.events.length})</summary>
            <pre>
              {trace.events
                .map((entry) => `+${((entry.at - trace.startedAt) / 1000).toFixed(2)}s ${entry.event} ${Object.entries(entry.detail).map(([key, value]) => `${key}=${value}`).join(" ")}`)
                .join("\n")}
            </pre>
          </details>
        </section>
      )}
    </main>
  );
}
