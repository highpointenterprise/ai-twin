"use client";
import { useState } from "react";
import type {
  AvailableNumber,
  NumberSearch,
  NumberSearchResult,
} from "@/lib/phone-numbers";
import type { PhoneNumberView } from "@/lib/types";
import { api } from "../api";

export function PurchaseNumber({
  disabled,
  onBusy,
  onPurchased,
}: {
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onPurchased: (number: PhoneNumberView) => void;
}) {
  const [query, setQuery] = useState<NumberSearch>({
    country: "US",
    type: "local",
    contains: "",
  });
  const [result, setResult] = useState<
    (NumberSearchResult & { query: NumberSearch }) | null
  >(null);
  const [selected, setSelected] = useState<AvailableNumber | null>(null);
  const [addressSid, setAddressSid] = useState(""),
    [bundleSid, setBundleSid] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section className="fields">
      <h2>Buy a phone number</h2>
      <p className="hint">
        Search voice-enabled numbers. Twilio bills your connected account for
        monthly rental and usage.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setSelected(null);
            setResult(null);
            const response = await api<NumberSearchResult>(
              `/numbers/available?${new URLSearchParams(query)}`,
            );
            setResult({ ...response, query: { ...query } });
          });
        }}
      >
        <fieldset disabled={disabled || busy} className="fields">
          <div className="row">
            <label>
              Country code
              <input
                required
                minLength={2}
                maxLength={2}
                pattern="[A-Za-z]{2}"
                value={query.country}
                onChange={(e) =>
                  setQuery({ ...query, country: e.target.value.toUpperCase() })
                }
                placeholder="US"
              />
            </label>
            <label>
              Number type
              <select
                value={query.type}
                onChange={(e) =>
                  setQuery({
                    ...query,
                    type: e.target.value as NumberSearch["type"],
                  })
                }
              >
                <option value="local">Local</option>
                <option value="tollFree">Toll-free</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <label>
              Contains digits
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={15}
                value={query.contains}
                onChange={(e) =>
                  setQuery({ ...query, contains: e.target.value })
                }
                placeholder="Optional"
              />
            </label>
          </div>
          <button>{busy ? "Working…" : "Search available numbers"}</button>
        </fieldset>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p>
            {result.monthlyPrice} {result.currency}/month per number, plus usage
            and applicable taxes or fees.
          </p>
          {!result.numbers.length && (
            <p className="empty">
              No matching voice numbers. Try another country, type, or digit
              filter.
            </p>
          )}
          <ul className="phone-search-results">
            {result.numbers.map((n) => (
              <li key={n.phoneNumber}>
                <div>
                  <strong>{n.phoneNumber}</strong>
                  <small>
                    {[n.locality, n.region, n.country]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
                <span className="hint">
                  Voice{n.capabilities.sms ? " · SMS" : ""}
                  {n.capabilities.mms ? " · MMS" : ""}
                </span>
                <button
                  className="ghost"
                  disabled={disabled || busy}
                  onClick={() => {
                    setSelected(n);
                    setError("");
                  }}
                >
                  Select {n.phoneNumber}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {selected && result && (
        <form
          className="phone-confirm fields"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const number = await api<PhoneNumberView>(
                "/numbers/purchase",
                "POST",
                {
                  ...result.query,
                  phoneNumber: selected.phoneNumber,
                  monthlyPrice: result.monthlyPrice,
                  currency: result.currency,
                  confirmPurchase: true,
                  ...(addressSid.trim()
                    ? { addressSid: addressSid.trim() }
                    : {}),
                  ...(bundleSid.trim() ? { bundleSid: bundleSid.trim() } : {}),
                },
              );
              onPurchased(number);
              setSelected(null);
              setResult(null);
            });
          }}
        >
          <h3>Confirm purchase: {selected.phoneNumber}</h3>
          <p>
            Buy for {result.monthlyPrice} {result.currency}/month, plus usage
            and taxes. This starts a recurring charge on your Twilio account.
          </p>
          <p className="hint">
            Address requirement: {selected.addressRequirements || "none"}. Some
            countries also require an approved regulatory bundle.
          </p>
          <fieldset disabled={disabled || busy} className="fields">
            <details>
              <summary>Regulatory details (if required)</summary>
              <div className="row">
                <label>
                  Twilio Address SID
                  <input
                    value={addressSid}
                    onChange={(e) => setAddressSid(e.target.value)}
                    pattern="AD[a-fA-F0-9]{32}"
                    placeholder="AD…"
                  />
                </label>
                <label>
                  Approved Bundle SID
                  <input
                    value={bundleSid}
                    onChange={(e) => setBundleSid(e.target.value)}
                    pattern="BU[a-fA-F0-9]{32}"
                    placeholder="BU…"
                  />
                </label>
              </div>
            </details>
            <div className="row">
              <button>{busy ? "Purchasing…" : "Confirm purchase"}</button>
              <button
                type="button"
                className="ghost"
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
