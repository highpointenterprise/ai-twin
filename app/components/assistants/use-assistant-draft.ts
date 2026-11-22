"use client";
import { useEffect, useState } from "react";
import { assistantSchema } from "@/lib/config";
import type { AgentConfig, AgentInput } from "@/lib/types";
import { api } from "../api";
export function useAssistantDraft(
  agents: AgentConfig[],
  onSaved: (agent: AgentConfig) => void,
) {
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [baseline, setBaseline] = useState<AgentInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty =
    draft !== null &&
    (!selected || JSON.stringify(draft) !== JSON.stringify(baseline));
  useEffect(() => {
    if (!draft && agents.length) {
      const input = assistantSchema.parse(agents[0]);
      setSelected(agents[0].id);
      setDraft(input);
      setBaseline(input);
    }
  }, [agents, draft]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const canLeave = () =>
    !busy &&
    (!dirty || window.confirm("Discard your unsaved assistant changes?"));
  function select(agent?: AgentConfig) {
    if (!canLeave()) return;
    const input = assistantSchema.parse(
      agent ?? {
        name: "New assistant",
        systemPrompt:
          "You are a helpful voice assistant. Be concise and use attached tools when appropriate.",
      },
    );
    setSelected(agent?.id ?? "");
    setDraft(input);
    setBaseline(agent ? input : null);
    setError("");
    setNotice("");
  }
  async function save() {
    if (!draft || busy) return;
    const parsed = assistantSchema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(" → ")}: ${issue.message}`)
          .join("\n"),
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<AgentConfig>(
        selected ? `/agents/${selected}` : "/agents",
        selected ? "PUT" : "POST",
        parsed.data,
      );
      const input = assistantSchema.parse(saved);
      setSelected(saved.id);
      setDraft(input);
      setBaseline(input);
      onSaved(saved);
      setNotice(
        "Assistant saved. New calls and meetings will use these settings.",
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Save failed. Your draft is preserved; please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  function discard() {
    if (!canLeave()) return;
    setDraft(baseline);
    setError("");
    setNotice("");
  }
  return {
    selected,
    draft,
    setDraft,
    busy,
    dirty,
    error,
    notice,
    select,
    save,
    discard,
    canLeave,
  };
}
