"use client";
import { useState } from "react";
export function CopyValue({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="copy-value">
      <span>{label}</span>
      <code>{value}</code>
      <button
        type="button"
        className="ghost"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("Copied");
          } catch {
            setStatus("Select and copy the value manually.");
          }
        }}
      >
        Copy
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}
