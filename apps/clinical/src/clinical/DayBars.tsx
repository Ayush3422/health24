import { useId } from 'react';
import { formatDate } from './format';

/**
 * One number per day, as columns (sp6-plan.md, Phase 8).
 *
 * A single series, so there is no legend: the caption names it. The tallest
 * column is labelled directly rather than every one, the axis says what the
 * days are, and the numbers themselves live in a table beneath — the chart
 * shows the shape, and nothing is only in the chart.
 *
 * Series blue is the same one the result trend uses, checked against the white
 * surface with the palette validator.
 */

const WIDTH = 720;
const HEIGHT = 160;
const MARGIN = { top: 18, right: 12, bottom: 26, left: 44 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const GAP = 2;

export type DayBar = { date: string; value: number };

export function DayBars({
  caption,
  points,
  format = (value: number) => value.toLocaleString('en-IN'),
}: {
  caption: string;
  points: DayBar[];
  format?: (value: number) => string;
}): JSX.Element {
  const titleId = useId();

  if (points.length === 0) {
    return <p className="muted">Nothing in this period.</p>;
  }

  const highest = Math.max(...points.map((point) => point.value), 1);
  const slot = PLOT_WIDTH / points.length;
  const barWidth = Math.max(slot - GAP, 1);
  const peak = points.reduce((best, point) => (point.value > best.value ? point : best), points[0]!);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const summary = `${caption}: ${format(peak.value)} at most, on ${formatDate(peak.date)}, over ${
    points.length
  } days from ${formatDate(first.date)} to ${formatDate(last.date)}.`;

  return (
    <div className="day-bars">
      <div className="day-bars__plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={titleId}>
          <title id={titleId}>{summary}</title>

          {/* The baseline the columns stand on, and the top of the scale. */}
          <line
            className="day-bars__axis"
            x1={MARGIN.left}
            y1={MARGIN.top + PLOT_HEIGHT}
            x2={MARGIN.left + PLOT_WIDTH}
            y2={MARGIN.top + PLOT_HEIGHT}
          />
          <line
            className="day-bars__grid"
            x1={MARGIN.left}
            y1={MARGIN.top}
            x2={MARGIN.left + PLOT_WIDTH}
            y2={MARGIN.top}
          />
          <text className="day-bars__tick" x={MARGIN.left - 8} y={MARGIN.top + 4} textAnchor="end">
            {format(highest)}
          </text>
          <text
            className="day-bars__tick"
            x={MARGIN.left - 8}
            y={MARGIN.top + PLOT_HEIGHT + 4}
            textAnchor="end"
          >
            0
          </text>

          {points.map((point, index) => {
            const height = (point.value / highest) * PLOT_HEIGHT;

            return (
              <rect
                key={point.date}
                className="day-bars__bar"
                x={MARGIN.left + index * slot + GAP / 2}
                y={MARGIN.top + PLOT_HEIGHT - height}
                width={barWidth}
                height={height}
                rx={Math.min(4, barWidth / 2)}
              />
            );
          })}

          {/* The tallest day, said outright; the rest are in the table. */}
          <text
            className="day-bars__peak"
            x={MARGIN.left + (points.indexOf(peak) + 0.5) * slot}
            y={MARGIN.top + PLOT_HEIGHT - (peak.value / highest) * PLOT_HEIGHT - 6}
            textAnchor="middle"
          >
            {format(peak.value)}
          </text>

          <text className="day-bars__tick" x={MARGIN.left} y={HEIGHT - 8}>
            {formatDate(first.date)}
          </text>
          {points.length > 1 ? (
            <text
              className="day-bars__tick"
              x={MARGIN.left + PLOT_WIDTH}
              y={HEIGHT - 8}
              textAnchor="end"
            >
              {formatDate(last.date)}
            </text>
          ) : null}
        </svg>
      </div>

      <details className="day-bars__table">
        <summary>The numbers, day by day</summary>
        <div className="table-scroll">
          <table className="table table--compact">
            <caption className="small muted">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">{caption}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <th scope="row">{formatDate(point.date)}</th>
                  <td>{format(point.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
