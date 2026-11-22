"use client";
import { useState } from "react";
import type { VoiceOption } from "@/lib/types";
import { api } from "../api";
export function VoiceLibrary({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="fields">
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setVoices(await api<VoiceOption[]>("/voices"));
            setLoaded(true);
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Cannot load voices.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Loading voices…" : "Load voice library"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error} You can still enter a voice ID above.
        </p>
      )}
      {loaded && !error && voices.length === 0 && (
        <p className="hint">
          No voices available. Enter a voice ID above or check the ElevenLabs
          configuration.
        </p>
      )}
      {voices.length > 0 && (
        <label>
          Voice library
          <select
            aria-label="Voice library"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Choose a voice</option>
            {value && !voices.some((v) => v.id === value) && (
              <option value={value}>Custom voice · {value}</option>
            )}
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
