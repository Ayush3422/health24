import { useMemo, useRef, useState, type PointerEvent } from 'react';
import type { ResultTrend } from '@health24/shared';
import { formatDate, formatDateTime } from './format';

/**
 * One analyte over time (SP4, T17).
 *
 * A single series, so no series legend: the caption names it. Hospital is
 * told by marker shape (circle for this hospital, diamond for another), never
 * colour alone; the reference range is a neutral wash; a result outside its
 * range carries a ▲ or ▼ in addition to its flag in the table. The hover
 * readout snaps to the nearest result and is also reachable by keyboard, and
 * the table beneath carries every value — the tooltip never gates one.
 *
 * Series blue and the danger red were checked with the dataviz palette
 * validator against the white surface (all checks pass).
 */

type Point = ResultTrend['points'][number];

const WIDTH = 640;
const HEIGHT = 250;
const MARGIN = { top: 20, right: 88, bottom: 34, left: 52 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const DAY_MS = 86_400_000;

const formatValue = (value: number) =>
  Number(value.toFixed(2)).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Clean tick values covering the range. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let low = min;
  let high = max;
  if (low === high) {
    low -= Math.abs(low) * 0.1 || 1;
    high += Math.abs(high) * 0.1 || 1;
  }

  const rough = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => (high - low) / candidate <= count) ??
    10 * magnitude;

  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= end + step / 1_000; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }

  return ticks;
}

const FLAG: Record<NonNullable<Point['interpretation']>, { glyph: string; label: string }> = {
  high: { glyph: '▲', label: 'High' },
  low: { glyph: '▼', label: 'Low' },
  abnormal: { glyph: '!', label: 'Abnormal' },
  normal: { glyph: '', label: 'Within range' },
};

const rangeText = (point: Point, unit: string) =>
  point.referenceLow !== null && point.referenceHigh !== null
    ? `${formatValue(point.referenceLow)}–${formatValue(point.referenceHigh)} ${unit}`
    : point.referenceHigh !== null
      ? `below ${formatValue(point.referenceHigh)} ${unit}`
      : point.referenceLow !== null
        ? `above ${formatValue(point.referenceLow)} ${unit}`
        : 'not stated';

export function TrendChart({ trend }: { trend: ResultTrend }): JSX.Element {
  const { analyte, points } = trend;
  const [active, setActive] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => {
    const times = points.map((point) => Date.parse(point.collectedAt));
    let tMin = Math.min(...times);
    let tMax = Math.max(...times);
    if (tMin === tMax) {
      tMin -= DAY_MS;
      tMax += DAY_MS;
    }

    const values = points.flatMap((point) =>
      [point.value, point.referenceLow, point.referenceHigh].filter(
        (value): value is number => value !== null,
      ),
    );
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const yMin = ticks[0] ?? 0;
    const yMax = ticks[ticks.length - 1] ?? 1;

    const x = (time: number) => MARGIN.left + ((time - tMin) / (tMax - tMin)) * PLOT_WIDTH;
    const y = (value: number) => MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * PLOT_HEIGHT;

    const positions = points.map((point, index) => ({ x: x(times[index]!), y: y(point.value) }));

    // The reference range as a wash, broken wherever a result has none. A
    // one-sided range ("below 200") runs to the edge of the plot.
    const bands: string[] = [];
    let run: Array<{ x: number; top: number; bottom: number }> = [];
    const flush = () => {
      if (run.length === 1) {
        const only = run[0]!;
        bands.push(`M${only.x - 8},${only.top} H${only.x + 8} V${only.bottom} H${only.x - 8} Z`);
      } else if (run.length > 1) {
        const upper = run.map((step) => `${step.x},${step.top}`).join(' L');
        const lower = [...run].reverse().map((step) => `${step.x},${step.bottom}`).join(' L');
        bands.push(`M${upper} L${lower} Z`);
      }
      run = [];
    };

    points.forEach((point, index) => {
      if (point.referenceLow === null && point.referenceHigh === null) {
        flush();
        return;
      }
      run.push({
        x: positions[index]!.x,
        top: y(point.referenceHigh ?? yMax),
        bottom: y(point.referenceLow ?? yMin),
      });
    });
    flush();

    // Date labels: every result when few, otherwise evenly spaced.
    const dateTicks =
      points.length <= 5
        ? times.map((time) => ({ x: x(time), label: formatDate(new Date(time).toISOString()) }))
        : [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const time = tMin + fraction * (tMax - tMin);
            return { x: x(time), label: formatDate(new Date(time).toISOString()) };
          });

    return { positions, ticks, y, bands, dateTicks };
  }, [points]);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || geometry.positions.length === 0) return;

    const pointerX = ((event.clientX - box.left) / box.width) * WIDTH;
    let nearest = 0;
    geometry.positions.forEach((position, index) => {
      if (Math.abs(position.x - pointerX) < Math.abs(geometry.positions[nearest]!.x - pointerX)) {
        nearest = index;
      }
    });
    setActive(nearest);
  };

  const hasOwn = points.some((point) => point.hospital.isOwn);
  const hasOther = points.some((point) => !point.hospital.isOwn);
  const activePoint = active === null ? null : points[active];
  const activePosition = active === null ? null : geometry.positions[active];
  const line = geometry.positions.map((position) => `${position.x},${position.y}`).join(' L');
  const last = geometry.positions[geometry.positions.length - 1];
  const lastPoint = points[points.length - 1];

  return (
    <figure className="trend">
      <figcaption>
        <strong>{analyte.label}</strong>{' '}
        <span className="small muted">
          in {analyte.unit} · {points.length === 1 ? '1 result' : `${points.length} results`}
        </span>
      </figcaption>

      <ul className="trend__legend" aria-label="Key">
        {hasOwn ? (
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="4.5" className="trend__marker" />
            </svg>{' '}
            This hospital
          </li>
        ) : null}
        {hasOther ? (
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" transform="rotate(45 6 6)" className="trend__marker" />
            </svg>{' '}
            Another hospital
          </li>
        ) : null}
        {geometry.bands.length > 0 ? (
          <li>
            <span className="trend__band-key" aria-hidden="true" /> Reference range on the report
          </li>
        ) : null}
        <li>▲ above range · ▼ below range</li>
      </ul>

      <div className="trend__plot" onPointerLeave={() => setActive(null)}>
        <svg
          ref={svg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${analyte.label} over time. Every value is listed in the table below.`}
          onPointerMove={onPointerMove}
        >
          {geometry.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + PLOT_WIDTH}
                y1={geometry.y(tick)}
                y2={geometry.y(tick)}
                className="trend__grid"
              />
              <text x={MARGIN.left - 8} y={geometry.y(tick) + 4} textAnchor="end" className="trend__axis">
                {formatValue(tick)}
              </text>
            </g>
          ))}

          {geometry.dateTicks.map((tick, index) => (
            <text key={`${tick.label}-${index}`} x={tick.x} y={HEIGHT - 10} textAnchor="middle" className="trend__axis">
              {tick.label}
            </text>
          ))}

          {geometry.bands.map((band) => (
            <path key={band} d={band} className="trend__band" />
          ))}

          {activePosition ? (
            <line
              x1={activePosition.x}
              x2={activePosition.x}
              y1={MARGIN.top}
              y2={MARGIN.top + PLOT_HEIGHT}
              className="trend__crosshair"
            />
          ) : null}

          {geometry.positions.length > 1 ? <path d={`M${line}`} className="trend__line" /> : null}

          {points.map((point, index) => {
            const position = geometry.positions[index]!;
            const flag = point.interpretation ? FLAG[point.interpretation] : null;

            return (
              <g
                key={point.observationId}
                tabIndex={0}
                aria-label={`${formatValue(point.value)} ${analyte.unit} on ${formatDateTime(point.collectedAt)}, ${point.hospital.isOwn ? 'this hospital' : point.hospital.name}${flag ? `, ${flag.label.toLowerCase()}` : ''}`}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className="trend__point"
              >
                <circle cx={position.x} cy={position.y} r={12} className="trend__hit" />
                {point.hospital.isOwn ? (
                  <circle cx={position.x} cy={position.y} r={4.5} className="trend__marker trend__marker--ringed" />
                ) : (
                  <rect
                    x={position.x - 4.5}
                    y={position.y - 4.5}
                    width={9}
                    height={9}
                    transform={`rotate(45 ${position.x} ${position.y})`}
                    className="trend__marker trend__marker--ringed"
                  />
                )}
                {flag?.glyph ? (
                  <text x={position.x} y={position.y - 11} textAnchor="middle" className="trend__glyph" aria-hidden="true">
                    {flag.glyph}
                  </text>
                ) : null}
              </g>
            );
          })}

          {last && lastPoint ? (
            <text x={last.x + 12} y={last.y + 4} className="trend__end-label">
              {`${formatValue(lastPoint.value)} ${analyte.unit}`}
            </text>
          ) : null}
        </svg>

        {activePoint && activePosition ? (
          <div
            // Held inside the plot: anchored by its left edge near the start, its right edge near the end.
            className={`trend__tooltip${
              activePosition.x < WIDTH * 0.25
                ? ' trend__tooltip--start'
                : activePosition.x > WIDTH * 0.75
                  ? ' trend__tooltip--end'
                  : ''
            }`}
            style={{
              left: `${(activePosition.x / WIDTH) * 100}%`,
              top: `${(activePosition.y / HEIGHT) * 100}%`,
            }}
          >
            <strong>{`${formatValue(activePoint.value)} ${analyte.unit}`}</strong>
            <span>{formatDateTime(activePoint.collectedAt)}</span>
            <span>{activePoint.hospital.isOwn ? 'This hospital' : activePoint.hospital.name}</span>
            <span>{`Range: ${rangeText(activePoint, analyte.unit)}`}</span>
            {activePoint.interpretation && activePoint.interpretation !== 'normal' ? (
              <span className="flag flag--high">{`${FLAG[activePoint.interpretation].glyph} ${FLAG[activePoint.interpretation].label}`}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <table className="table table--compact trend__table">
        <caption className="small muted">Every result in the graph</caption>
        <thead>
          <tr>
            <th scope="col">Collected</th>
            <th scope="col">Result</th>
            <th scope="col">As reported</th>
            <th scope="col">Reference range</th>
            <th scope="col">Flag</th>
            <th scope="col">Hospital</th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((point) => (
            <tr key={point.observationId}>
              <td>{formatDateTime(point.collectedAt)}</td>
              <td>{`${formatValue(point.value)} ${analyte.unit}`}</td>
              <td className="muted">{`${formatValue(point.valueAsEntered)} ${point.unitAsEntered}`}</td>
              <td>{rangeText(point, analyte.unit)}</td>
              <td>
                <Flag interpretation={point.interpretation} />
              </td>
              <td>{point.hospital.isOwn ? 'This hospital' : point.hospital.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A result's flag: an icon and a word, never colour alone. */
export function Flag({ interpretation }: { interpretation: Point['interpretation'] }): JSX.Element {
  if (!interpretation) return <span className="muted">—</span>;

  const flag = FLAG[interpretation];
  return (
    <span className={`flag flag--${interpretation}`}>
      {flag.glyph ? `${flag.glyph} ` : ''}
      {flag.label}
    </span>
  );
}
