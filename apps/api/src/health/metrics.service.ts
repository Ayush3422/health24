import { Injectable } from '@nestjs/common';

/**
 * The few numbers worth having at this size (sp7-plan.md, T9).
 *
 * Deliberately small and dependency-free: counters, and one histogram of
 * request durations, in the Prometheus text format that CloudWatch, Grafana
 * and anything else can scrape. A metrics library would bring a configuration
 * surface, an exposition format to keep in step and a supply-chain dependency,
 * for numbers a hospital-sized deployment can count in memory.
 *
 * What is not here matters as much as what is. **A metric never carries a
 * patient**: no label holds an id, a name or an MRN, because a time series is
 * kept for a year and read by anybody with the dashboard. Routes are recorded
 * as their pattern — `/patients/:id`, never `/patients/01a0…` — so the
 * cardinality stays bounded and the label says nothing about who was read.
 */

/** Seconds. The buckets a request is sorted into, loosely by how it feels. */
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string>;

const labelKey = (labels: Labels): string =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '')}"`)
    .join(',');

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, { counts: number[]; sum: number }>>();
  private readonly gauges = new Map<string, () => Promise<number> | number>();

  private readonly help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  count(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = labelKey(labels);

    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    const series = this.histograms.get(name) ?? new Map<string, { counts: number[]; sum: number }>();
    const key = labelKey(labels);
    const entry = series.get(key) ?? { counts: new Array<number>(BUCKETS.length + 1).fill(0), sum: 0 };

    const bucket = BUCKETS.findIndex((edge) => seconds <= edge);
    entry.counts[bucket === -1 ? BUCKETS.length : bucket]! += 1;
    entry.sum += seconds;

    series.set(key, entry);
    this.histograms.set(name, series);
  }

  /** A number read at scrape time, such as how deep a queue is right now. */
  gauge(name: string, help: string, read: () => Promise<number> | number): void {
    this.describe(name, help);
    this.gauges.set(name, read);
  }

  /** Everything, in the Prometheus text format. */
  async scrape(): Promise<string> {
    const lines: string[] = [];

    const header = (name: string, type: string) => {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    for (const [name, series] of this.counters) {
      header(name, 'counter');
      for (const [labels, value] of series) {
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${String(value)}`);
      }
    }

    for (const [name, series] of this.histograms) {
      header(name, 'histogram');

      for (const [labels, entry] of series) {
        const prefix = labels ? `${labels},` : '';
        let cumulative = 0;

        for (const [index, edge] of BUCKETS.entries()) {
          cumulative += entry.counts[index]!;
          lines.push(`${name}_bucket{${prefix}le="${String(edge)}"} ${String(cumulative)}`);
        }

        cumulative += entry.counts[BUCKETS.length]!;
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${String(cumulative)}`);
        lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${entry.sum.toFixed(6)}`);
        lines.push(`${name}_count${labels ? `{${labels}}` : ''} ${String(cumulative)}`);
      }
    }

    for (const [name, read] of this.gauges) {
      header(name, 'gauge');

      try {
        lines.push(`${name} ${String(await read())}`);
      } catch {
        // A gauge that cannot be read is left out rather than reported as
        // zero, which would look like a queue that had just been drained.
      }
    }

    return `${lines.join('\n')}\n`;
  }
}
