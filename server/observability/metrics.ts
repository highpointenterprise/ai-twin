type Labels = Readonly<Record<string, string>>;

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}="${escapeLabel(labels[name])}"`)
    .join(",");
const series = (name: string, key: string, value: number): string =>
  `${name}${key ? `{${key}}` : ""} ${value}`;

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}
  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values].map(([key, value]) => series(this.name, key, value)),
    ];
  }
}

export class Gauge implements Metric {
  private readonly values = new Map<string, number>();
  private collector?: () => Promise<number> | number;
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }
  collect(collector: () => Promise<number> | number): void {
    this.collector = collector;
  }
  async refresh(): Promise<void> {
    if (this.collector) this.set(await this.collector());
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      ...[...this.values].map(([key, value]) => series(this.name, key, value)),
    ];
  }
}

export class Histogram implements Metric {
  private readonly buckets = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly bounds: readonly number[],
  ) {}
  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const counts = this.buckets.get(key) ?? this.bounds.map(() => 0);
    this.bounds.forEach((bound, index) => {
      if (value <= bound) counts[index]++;
    });
    this.buckets.set(key, counts);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, counts] of this.buckets) {
      const prefix = key ? `${key},` : "";
      this.bounds.forEach((bound, index) =>
        lines.push(series(`${this.name}_bucket`, `${prefix}le="${bound}"`, counts[index])),
      );
      lines.push(series(`${this.name}_bucket`, `${prefix}le="+Inf"`, this.counts.get(key) ?? 0));
      lines.push(series(`${this.name}_sum`, key, this.sums.get(key) ?? 0));
      lines.push(series(`${this.name}_count`, key, this.counts.get(key) ?? 0));
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];
  private readonly gauges: Gauge[] = [];
  counter(name: string, help: string): Counter {
    const metric = new Counter(name, help);
    this.metrics.push(metric);
    return metric;
  }
  gauge(name: string, help: string): Gauge {
    const metric = new Gauge(name, help);
    this.metrics.push(metric);
    this.gauges.push(metric);
    return metric;
  }
  histogram(name: string, help: string, bounds: readonly number[]): Histogram {
    const metric = new Histogram(name, help, bounds);
    this.metrics.push(metric);
    return metric;
  }
  async render(): Promise<string> {
    await Promise.allSettled(this.gauges.map((gauge) => gauge.refresh()));
    return `${this.metrics.flatMap((metric) => metric.render()).join("\n")}\n`;
  }
}

export const metrics = new MetricsRegistry();

export const httpRequests = metrics.counter(
  "api_http_requests_total",
  "API requests by method, route and status class.",
);
export const httpDuration = metrics.histogram(
  "api_http_request_duration_seconds",
  "API request latency.",
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
);
export const callsAdmitted = metrics.counter(
  "call_queue_admitted_total",
  "Calls accepted into the dispatch queue.",
);
export const callsDispatched = metrics.counter(
  "call_queue_dispatch_total",
  "Dispatch outcomes by result.",
);
export const queueWait = metrics.histogram(
  "call_queue_wait_seconds",
  "Time between admission and dial.",
  [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
);
export const queueDepth = metrics.gauge("call_queue_depth", "Calls waiting for capacity.");
export const activeLeases = metrics.gauge("call_active_leases", "Calls holding a concurrency lease.");
