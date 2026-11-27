"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentInput } from "../../../lib/types";
import { deliveryTags, expressiveVoice, voiceModels } from "../../../lib/voice";
import { VoiceLibrary } from "./voice-library";

export function VoiceSettings({ value: a, onChange }: { value: AgentInput; onChange: (value: AgentInput) => void }) {
  const set = (patch: Partial<AgentInput["voice"]>) => onChange({ ...a, voice: { ...a.voice, ...patch } });
  const expressive = expressiveVoice(a.voice.model);
  const [text, setText] = useState("Hello, it's good to speak with you. Thanks for your time. Goodbye.");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const generate = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setPreview("");
    try {
      const response = await fetch("/api/backend/voices/preview", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: a.voiceId, voice: a.voice, text }) });
      if (!response.ok) throw new Error((await response.json()).error || "Cannot generate voice preview.");
      const audio = await response.blob();
      if (!controller.signal.aborted) setPreview(URL.createObjectURL(audio));
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Cannot preview voice."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const numeric = (label: string, key: "stability" | "similarityBoost" | "speed" | "style", min: number, max: number, fallback: number) => <label>{label}<input type="number" min={min} max={max} step={0.05} value={a.voice[key] ?? fallback} onChange={e => set({ [key]: Number(e.target.value) })} /></label>;
  return <div className="fields">
    <div className="provider"><span className="dot" />ElevenLabs<span className="subtle">Streaming speech</span></div>
    <label>Voice ID<input value={a.voiceId} onChange={e => onChange({ ...a, voiceId: e.target.value })} placeholder="Voice ID, or leave blank for server default" maxLength={128} /></label>
    <VoiceLibrary value={a.voiceId} onChange={voiceId => onChange({ ...a, voiceId })} />
    <label>Voice model<select aria-label="Voice model" value={a.voice.model} onChange={e => set({ model: e.target.value as AgentInput["voice"]["model"] })}>
      {voiceModels.map(model => <option key={model} value={model}>{model === "eleven_v4_turbo" ? "Eleven v4 Turbo · expressive" : model === "eleven_v3_conversational" ? "Eleven v3 Conversational · expressive" : model}</option>)}
    </select></label>
    {expressive ? <>
      <label>Voice delivery<select value={a.voice.delivery ?? "neutral"} onChange={e => set({ delivery: e.target.value as AgentInput["voice"]["delivery"] })}>
        {Object.keys(deliveryTags).map(delivery => <option key={delivery} value={delivery}>{delivery[0].toUpperCase() + delivery.slice(1)}</option>)}
      </select></label>
      <label>Voice delivery instructions<textarea value={a.voice.deliveryInstructions ?? ""} maxLength={1000} rows={4} placeholder="Warm and conversational. Calm when explaining. Keep goodbyes brief, with no stretched words or dramatic pauses." onChange={e => set({ deliveryInstructions: e.target.value })} /></label>
      <p className="hint">The assistant translates delivery guidance into emotion tags for ElevenLabs. You can also use tags such as [warmly], [calmly], [excited], or [angry] before a phrase. Results depend on the selected voice. These models use their own pacing and voice settings; the standard sliders do not apply here.</p>
    </> : <>
      <div className="row">{numeric("Stability", "stability", 0, 1, 0.5)}{numeric("Similarity boost", "similarityBoost", 0, 1, 0.75)}{numeric("Speed", "speed", 0.7, 1.2, 1)}{numeric("Style exaggeration", "style", 0, 1, 0)}</div>
      <label className="check"><input type="checkbox" checked={a.voice.useSpeakerBoost ?? false} onChange={e => set({ useSpeakerBoost: e.target.checked })} />Speaker boost</label>
      <p className="hint">Start around stability 0.5, similarity 0.75, speed 1.0 and style 0. Lower stability allows more variation; high stability can sound flat. Style exaggeration and speaker boost can add latency. For emotion tags and delivery instructions, choose an expressive model.</p>
    </>}
    <fieldset className="fields"><legend>Try the voice</legend>
      <label>Preview text<textarea value={text} onChange={e => setText(e.target.value)} maxLength={600} rows={3} /></label>
      <button type="button" disabled={busy || !text.trim()} onClick={() => void generate()}>{busy ? "Generating preview…" : "Preview voice"}</button>
      <p className="hint">Uses your current unsaved voice settings and ElevenLabs credits. Preview is 8 kHz mono to approximate telephone quality. Use audio tags in this sample to test phrase delivery; free-text instructions guide generated replies during calls.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {preview && <audio aria-label="Voice preview" controls src={preview} />}
    </fieldset>
  </div>;
}
