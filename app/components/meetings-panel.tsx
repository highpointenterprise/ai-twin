"use client";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import type { AgentConfig, CallTraceView } from "../../lib/types";
import type { MeetingRecord, MeetingReadiness } from "../../lib/meetings";
import { api } from "./api";
const terminal = (phase: string) =>
  ["ended", "failed", "needs-login"].includes(phase);
export function MeetingsPanel({ agents }: { agents: AgentConfig[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? ""),
    [url, setUrl] = useState(""),
    [avatar, setAvatar] = useState(false),
    [avatarId, setAvatarId] = useState(""),
    [context, setContext] = useState("");
  const [records, setRecords] = useState<MeetingRecord[]>([]),
    [config, setConfig] = useState<MeetingReadiness | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [trace, setTrace] = useState<CallTraceView | null>(null);
  useEffect(() => {
    let disposed = false;
    void api<MeetingReadiness>("/meetings/config")
      .then((value) => {
        if (!disposed) {
          setConfig(value);
          setAvatarId(value.defaultAvatarId);
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const list = await api<MeetingRecord[]>("/meetings");
        if (!disposed) setRecords(list);
        if (selected) {
          const value = await api<CallTraceView>(
            `/meetings/${selected}/trace`,
          ).catch(() => null);
          if (!disposed) setTrace(value);
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "Could not load meetings.");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selected]);
  const join = async () => {
    setBusy(true);
    setError("");
    try {
      const meeting = await api<MeetingRecord>("/meetings", "POST", {
        agentId,
        meetingUrl: url,
        avatarEnabled: avatar,
        avatarId: avatar ? avatarId : "",
        context,
      });
      setRecords((list) => [
        meeting,
        ...list.filter((r) => r.id !== meeting.id),
      ]);
      setSelected(meeting.id);
      setTrace(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the agent.");
    } finally {
      setBusy(false);
    }
  };
  const leave = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const ended = await api<MeetingRecord>(`/meetings/${id}/end`, "POST", {});
      setRecords((list) => list.map((r) => (r.id === id ? ended : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not leave the meeting.");
    } finally {
      setBusy(false);
    }
  };
  const missing = [
    ...(config?.missing ?? []),
    ...(avatar ? (config?.avatarMissing ?? []) : []),
  ];
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Send an agent to Google Meet</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="fields"
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <div className="row">
              <label>
                Assistant
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  required
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Appearance
                <select
                  value={avatar ? "avatar" : "voice"}
                  onChange={(e) => setAvatar(e.target.value === "avatar")}
                >
                  <option value="voice">Voice only</option>
                  <option value="avatar">HeyGen avatar</option>
                </select>
              </label>
            </div>
            <label>
              Google Meet link
              <Input
                type="url"
                placeholder="https://meet.google.com/abc-defg-hij"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </label>
            {avatar && (
              <label>
                HeyGen LiveAvatar ID
                <Input
                  value={avatarId}
                  onChange={(e) => setAvatarId(e.target.value)}
                  placeholder="Your LiveAvatar avatar ID"
                  required
                />
              </label>
            )}
            <label>
              Meeting context (optional)
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="What should the agent help the customer with?"
              />
            </label>
            <p className="hint">
              Uses your assistant's prompt, voice and custom functions. The host
              may need to admit the agent.
            </p>
            {!!missing.length && (
              <p className="hint">Server setup needed: {missing.join(", ")}.</p>
            )}
            <Button type="submit" disabled={busy || !agentId}>
              {busy ? "Working…" : "Send agent"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Meeting sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {!records.length ? (
            <p className="hint">No meeting sessions yet.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Meeting</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td>{r.displayName}</td>
                      <td>
                        <a href={r.meetingUrl} target="_blank" rel="noreferrer">
                          {r.meetingUrl.replace("https://meet.google.com/", "")}
                        </a>
                      </td>
                      <td>
                        {r.phase.replaceAll("-", " ")}
                        {r.reason && <p className="hint">{r.reason}</p>}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelected(r.id);
                              setTrace(null);
                            }}
                          >
                            Details
                          </Button>
                          {!terminal(r.phase) && (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => void leave(r.id)}
                            >
                              Leave meeting
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>Conversation</CardTitle>
          </CardHeader>
          <CardContent>
            {trace?.transcript.length ? (
              <ol className="transcript">
                {trace.transcript.map((line, i) => (
                  <li key={i}>
                    <b>{line.role === "caller" ? "Meeting" : "Agent"}:</b>{" "}
                    {line.text}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">
                Transcript appears after the agent joins and the conversation
                starts.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
