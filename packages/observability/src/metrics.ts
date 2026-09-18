/**
 * Metrics (S-A6). A registry of counters, gauges and histograms rendered as Prometheus
 * text — which, as ADR-002 put it, is a string join.
 */

export interface MetricLabels {
  readonly [label: string]: string;
}

interface Series<T> {
  labels: MetricLabels;
  value: T;
}

function labelKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",");
  return `{${rendered}}`;
}

abstract class Metric<T> {
  protected readonly series = new Map<string, Series<T>>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  abstract readonly type: string;
  protected abstract initial(): T;
  protected abstract renderSeries(labels: MetricLabels, value: T): string[];

  protected at(labels: MetricLabels): Series<T> {
    const key = labelKey(labels);
    let series = this.series.get(key);
    if (!series) {
      series = { labels, value: this.initial() };
      this.series.set(key, series);
    }
    return series;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const { labels, value } of this.series.values()) {
      lines.push(...this.renderSeries(labels, value));
    }
    return lines.join("\n");
  }

  reset(): void {
    this.series.clear();
  }
}

export class Counter extends Metric<number> {
  readonly type = "counter";
  protected initial(): number {
    return 0;
  }
  increment(labels: MetricLabels = {}, by = 1): void {
    this.at(labels).value += by;
  }
  get(labels: MetricLabels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }
  protected renderSeries(labels: MetricLabels, value: number): string[] {
    return [`${this.name}${renderLabels(labels)} ${value}`];
  }
}

export class Gauge extends Metric<number> {
  readonly type = "gauge";
  protected initial(): number {
    return 0;
  }
  set(value: number, labels: MetricLabels = {}): void {
    this.at(labels).value = value;
  }
  get(labels: MetricLabels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }
  protected renderSeries(labels: MetricLabels, value: number): string[] {
    return [`${this.name}${renderLabels(labels)} ${value}`];
  }
}

interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

/** Latency buckets in seconds, chosen for a pipeline whose source is a ~30-minute batch. */
export const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800] as const;

export class Histogram extends Metric<HistogramState> {
  readonly type = "histogram";

  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help);
  }

  protected initial(): HistogramState {
    return { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const state = this.at(labels).value;
    state.sum += value;
    state.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= (this.buckets[i] as number)) state.counts[i] = (state.counts[i] as number) + 1;
    }
  }

  protected renderSeries(labels: MetricLabels, state: HistogramState): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.buckets.length; i += 1) {
      lines.push(
        `${this.name}_bucket${renderLabels({ ...labels, le: String(this.buckets[i]) })} ${state.counts[i]}`,
      );
    }
    lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${state.count}`);
    lines.push(`${this.name}_sum${renderLabels(labels)} ${state.sum}`);
    lines.push(`${this.name}_count${renderLabels(labels)} ${state.count}`);
    return lines;
  }
}

interface Renderable {
  render(): string;
  reset(): void;
}

export class Registry {
  private readonly metrics: Renderable[] = [];

  counter(name: string, help: string): Counter {
    return this.register(new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.register(new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.register(new Histogram(name, help, buckets));
  }

  private register<M extends Renderable>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }

  /** Prometheus text exposition format. */
  render(): string {
    return `${this.metrics.map((metric) => metric.render()).join("\n")}\n`;
  }

  reset(): void {
    for (const metric of this.metrics) metric.reset();
  }
}

export const CONTENT_TYPE_PROMETHEUS = "text/plain; version=0.0.4; charset=utf-8";
