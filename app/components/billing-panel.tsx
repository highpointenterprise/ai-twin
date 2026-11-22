"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { PricingPolicy } from "@/server/billing/policy";

type Summary = {
  note: string;
  groups: {
    _id: string;
    calls: number;
    minutes: number;
    reportedUsd: number;
    calculatedUsd: number;
    estimatedUsd: number;
    knownSubtotalUsd: number;
    incompleteCalls: number;
    pendingCalls: number;
  }[];
};
const money = (v: number) => `$${v.toFixed(6)}`;
const label = (v: string) =>
  v
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("Usd", "USD")
    .replaceAll("Per", "per ");
function RateFields({
  value,
  onChange,
  prefix = "",
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  prefix?: string;
}) {
  return (
    <div className="fields">
      {Object.entries(value).map(([key, item]) =>
        typeof item === "number" ? (
          <label key={key}>
            {label(key)}
            <input
              aria-label={`${prefix} ${label(key)}`.trim()}
              type="number"
              min="0"
              step="any"
              required
              value={item}
              onChange={(e) =>
                onChange({ ...value, [key]: Number(e.target.value) })
              }
            />
          </label>
        ) : item && typeof item === "object" ? (
          <details key={key}>
            <summary>{label(key)}</summary>
            <RateFields
              value={item as Record<string, unknown>}
              prefix={`${prefix} ${label(key)}`}
              onChange={(updated) => onChange({ ...value, [key]: updated })}
            />
          </details>
        ) : null,
      )}
    </div>
  );
}
export function BillingPanel() {
  const now = new Date(),
    first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [from, setFrom] = useState(first.toISOString().slice(0, 10)),
    [to, setTo] = useState(now.toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState("day"),
    [summary, setSummary] = useState<Summary | null>(null);
  const [policy, setPolicy] = useState<
    (PricingPolicy & { sources: string[] }) | null
  >(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [toolId, setToolId] = useState(""),
    [toolRate, setToolRate] = useState("0");
  useEffect(() => {
    api<PricingPolicy & { sources: string[] }>("/billing/pricing")
      .then(setPolicy)
      .catch((e) => setError(e.message));
  }, []);
  async function report() {
    setBusy(true);
    setError("");
    try {
      const end = new Date(`${to}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      setSummary(
        await api<Summary>(
          `/billing/summary?${new URLSearchParams({ from: `${from}T00:00:00.000Z`, to: end.toISOString(), groupBy })}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot load costs.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fields">
      <section className="fields">
        <h2>Call usage & costs</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void report();
          }}
          className="row"
        >
          <label>
            From (UTC)
            <input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Through (UTC)
            <input
              type="date"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label>
            Group by
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
            >
              <option value="day">Day</option>
              <option value="month">Month</option>
            </select>
          </label>
          <button disabled={busy}>Load usage report</button>
        </form>
        {summary && (
          <>
            <div className="table-scroll">
              <table aria-label="Usage report">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Calls</th>
                    <th>Minutes</th>
                    <th>Reported charges</th>
                    <th>Measured usage × rate</th>
                    <th>Estimates</th>
                    <th>Known subtotal</th>
                    <th>Incomplete / pending</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.groups.map((g) => (
                    <tr key={g._id}>
                      <td>{g._id}</td>
                      <td>{g.calls}</td>
                      <td>{g.minutes.toFixed(2)}</td>
                      <td>{money(g.reportedUsd)}</td>
                      <td>{money(g.calculatedUsd)}</td>
                      <td>{money(g.estimatedUsd)}</td>
                      <td>{money(g.knownSubtotalUsd)}</td>
                      <td>
                        {g.incompleteCalls} / {g.pendingCalls}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!summary.groups.length && (
              <p>No processed calls in this period.</p>
            )}
            <p className="hint">
              {summary.note} Open Calls for individual usage and costs.
            </p>
          </>
        )}
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {policy && (
        <section className="fields">
          <h2>Pricing & allocation</h2>
          <p className="hint">
            Changes apply to new calls. Existing calls retain their pricing
            version. All rates are in USD; provider invoices may also include
            taxes and plan fees.
          </p>
          <form
            className="fields"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setNotice("");
              try {
                const saved = await api<PricingPolicy & { sources: string[] }>(
                  "/billing/pricing",
                  "PUT",
                  {
                    expectedVersion: policy.version,
                    rates: policy.rates,
                    hosting: policy.hosting,
                    note: policy.note,
                  },
                );
                setPolicy(saved);
                setNotice("Pricing saved for future calls.");
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save pricing.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              <details>
                <summary>Provider rates</summary>
                <p className="hint">
                  Models: USD per million tokens. Transcription: USD per minute.
                  Speech: USD per 1,000 characters. Telephony rates must match
                  your destinations and account plan.
                </p>
                <RateFields
                  value={policy.rates as unknown as Record<string, unknown>}
                  onChange={(rates) =>
                    setPolicy({
                      ...policy,
                      rates: rates as unknown as PricingPolicy["rates"],
                    })
                  }
                />
              </details>
              <label>
                ElevenLabs USD per credit (leave empty if unknown)
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={policy.rates.elevenlabsCreditUsd ?? ""}
                  onChange={(e) => {
                    const rates = { ...policy.rates };
                    if (e.target.value === "") delete rates.elevenlabsCreditUsd;
                    else rates.elevenlabsCreditUsd = Number(e.target.value);
                    setPolicy({ ...policy, rates });
                  }}
                />
              </label>
              <p className="hint">
                Credit debits come from matched provider history.
                Character-based estimates are shown separately when actual
                credits cannot be obtained.
              </p>
              <details>
                <summary>External API / tool pricing</summary>
                <div className="row">
                  <label>
                    Tool ID
                    <input
                      value={toolId}
                      onChange={(e) => setToolId(e.target.value)}
                    />
                  </label>
                  <label>
                    USD per attempted request
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={toolRate}
                      onChange={(e) => setToolRate(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!toolId.trim()}
                    onClick={() => {
                      setPolicy({
                        ...policy,
                        rates: {
                          ...policy.rates,
                          api: {
                            ...policy.rates.api,
                            [toolId.trim()]: Number(toolRate),
                          },
                        },
                      });
                      setToolId("");
                    }}
                  >
                    Add tool rate
                  </button>
                </div>
              </details>
              <details>
                <summary>AWS & infrastructure estimates</summary>
                <p className="hint">
                  Suggested deployment: ECS/Fargate in us-east-1. Allocate
                  shared compute across concurrent calls. Include idle capacity,
                  load balancer, database, cache, logs and recurring phone
                  rental in your monthly budget. Do not count the same resource
                  in multiple allocations.
                </p>
                <label>
                  Region
                  <input
                    value={policy.hosting.region ?? "us-east-1"}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        hosting: { ...policy.hosting, region: e.target.value },
                      })
                    }
                  />
                </label>
                <RateFields
                  value={policy.hosting as unknown as Record<string, unknown>}
                  onChange={(hosting) =>
                    setPolicy({
                      ...policy,
                      hosting: hosting as unknown as PricingPolicy["hosting"],
                    })
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    checked={!!policy.hosting.configured}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        hosting: {
                          ...policy.hosting,
                          configured: e.target.checked,
                        },
                      })
                    }
                  />
                  My infrastructure budget and allocation rates are configured
                </label>
              </details>
              <label>
                Pricing note
                <input
                  required
                  maxLength={500}
                  value={policy.note}
                  onChange={(e) =>
                    setPolicy({ ...policy, note: e.target.value })
                  }
                />
              </label>
              <button>Save pricing</button>
            </fieldset>
          </form>
          <details>
            <summary>Official pricing references</summary>
            <ul>
              {policy.sources.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {new URL(url).hostname}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
