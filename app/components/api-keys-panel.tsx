"use client";
import { useEffect, useState } from "react";
import type { AgentConfig, PhoneNumberView } from "@/lib/types";
import { api } from "./api";
import { CopyValue } from "./copy-value";
type Key = {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  invalidated?: boolean;
};
type KeyList = {
  keys: Key[];
  nextCursor: string | null;
  userId: string;
  apiBaseUrl: string;
};
function KeyRow({
  item,
  changed,
}: {
  item: Key;
  changed: () => Promise<void>;
}) {
  const [name, setName] = useState(item.name),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function update(method: string) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/api-keys/${item.id}`,
        method,
        method === "PATCH" ? { name } : undefined,
      );
      await changed();
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update API key.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="fields phone-card" aria-label={`API key ${item.name}`}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void update("PATCH");
        }}
      >
        <label>
          Key name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            disabled={busy || !!item.revokedAt}
          />
        </label>
        <button disabled={busy || !!item.revokedAt || name === item.name}>
          Save name
        </button>
        <span>
          Ending in …{item.hint} · {item.revokedAt ? "Revoked" : item.invalidated ? "Invalidated by account security change" : "Active"}
        </span>
      </form>
      <small>
        Created {new Date(item.createdAt).toLocaleString()} · Last used{" "}
        {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "Never"}
      </small>
      {!item.revokedAt &&
        (confirm ? (
          <div className="row">
            <span>Revoking blocks new API requests immediately.</span>
            <button disabled={busy} onClick={() => void update("DELETE")}>
              Confirm revoke
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="ghost" onClick={() => setConfirm(true)}>
            Revoke key
          </button>
        ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </article>
  );
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function ApiKeysPanel({
  userId,
  agents,
  numbers,
}: {
  userId: string;
  agents: AgentConfig[];
  numbers: PhoneNumberView[];
}) {
  const [data, setData] = useState<KeyList | null>(null),
    [name, setName] = useState("");
  const [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [assistantId, setAssistantId] = useState(agents[0]?.id ?? ""),
    [phoneNumberId, setPhoneNumberId] = useState(
      numbers.find((n) => n.id)?.id ?? "",
    ),
    [customer, setCustomer] = useState("+14155550123");
  async function load(after?: string) {
    const result = await api<KeyList>(
      `/api-keys${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    );
    setData((old) =>
      after && old
        ? { ...result, keys: [...old.keys, ...result.keys] }
        : result,
    );
  }
  useEffect(() => {
    let active = true;
    api<KeyList>("/api-keys")
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const body = {
    assistantId: assistantId || "ASSISTANT_UUID",
    phoneNumberId: phoneNumberId || "PHONE_NUMBER_UUID",
    customer: { number: customer },
  };
  const curl = `curl -X POST ${quote(`${data?.apiBaseUrl || "https://YOUR_BACKEND"}/call`)} \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d ${quote(JSON.stringify(body, null, 2))}`;
  return (
    <div className="fields">
      <h2>API keys</h2>
      <CopyValue label="Workspace / User ID" value={userId} />
      {data?.apiBaseUrl ? (
        <CopyValue label="API base URL" value={data.apiBaseUrl} />
      ) : (
        <p className="hint">
          The backend's PUBLIC_BASE_URL must be configured to show your public
          API URL.
        </p>
      )}
      <p className="hint">
        Keys access only your workspace. Store them on your server. The full key
        is shown once, immediately after creation.
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setSecret("");
          try {
            const result = await api<{ key: string }>("/api-keys", "POST", {
              name,
            });
            setSecret(result.key);
            setName("");
            await load();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not create key.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          New key name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production server"
          />
        </label>
        <button disabled={busy || !name.trim()}>Generate API key</button>
      </form>
      {secret && (
        <section className="fields" aria-label="New API key">
          <p>Copy this key now. It cannot be retrieved later.</p>
          <CopyValue label="New API key" value={secret} />
          <button type="button" className="ghost" onClick={() => setSecret("")}>
            Dismiss key
          </button>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data?.keys.map((key) => (
        <KeyRow key={key.id} item={key} changed={() => load()} />
      ))}
      {data && !data.keys.length && <p>No API keys yet.</p>}
      {data?.nextCursor && (
        <button
          onClick={() =>
            void load(data.nextCursor!).catch((e) => setError(e.message))
          }
        >
          Load more keys
        </button>
      )}
      <section className="fields">
        <h2>Create an outbound call</h2>
        <p className="hint">
          POST /call uses your API key to select your workspace. A successful
          request returns HTTP 201 and the call object; dialing continues in the
          background.
        </p>
        <label>
          Assistant
          <select
            value={assistantId}
            onChange={(e) => setAssistantId(e.target.value)}
          >
            <option value="">Choose assistant</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {assistantId && (
          <CopyValue label="Selected Assistant ID" value={assistantId} />
        )}
        <label>
          Phone number
          <select
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
          >
            <option value="">Choose phone number</option>
            {numbers
              .filter((n) => n.id && n.capabilities?.voice !== false)
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.phoneNumber} · {n.label}
                </option>
              ))}
          </select>
        </label>
        {phoneNumberId && (
          <CopyValue label="Selected Phone Number ID" value={phoneNumberId} />
        )}
        <label>
          Customer phone number
          <input
            type="tel"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </label>
        <CopyValue label="Create Call cURL" value={curl} />
        <p className="hint">
          Replace YOUR_API_KEY with your private key. Customer numbers must use
          E.164 format. Saved or inline assistants, assistantOverrides,
          customer-specific overrides, customers batches and schedulePlan are
          supported. Unsupported transports, squads, workflows, customer IDs,
          transient numbers and extensions return validation errors.
        </p>
      </section>
    </div>
  );
}
