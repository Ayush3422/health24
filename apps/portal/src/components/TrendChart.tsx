import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResultTrend } from '@health24/shared';
import { formatDate, formatDateTime, formatNumber } from '../format';
import { niceTicks } from '../trend';
import { Flag, useRangeLabel } from './ResultText';

/**
 * One test over time, for a phone screen.
 *
 * A single series, so no series legend: the heading names it. The lab's range
 * is a neutral wash; a value outside it carries ▲ or ▼. The readout follows a
 * finger or pointer to the nearest result and is reachable by keyboard, and the
 * list beneath carries every value — the chart never gates one. Series blue and
 * the danger red are the clinical app's, checked with the dataviz validator
 * against the white surface.
 */

// About the width the plot gets on a 360-pixel phone, so text in the chart
// renders near its stated size rather than scaled down.
const WIDTH = 300;
const HEIGHT = 200;
const MARGIN = { top: 24, right: 64, bottom: 28, left: 40 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const DAY_MS = 86_400_000;

export function TrendChart({ trend }: { trend: ResultTrend }): JSX.Element {
  const { t } = useTranslation();
  const rangeLabel = useRangeLabel();
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
    const ticks = niceTicks(Math.min(...values), Math.max(...values), 4);
    const yMin = ticks[0] ?? 0;
    const yMax = ticks[ticks.length - 1] ?? 1;

    const x = (time: number) => MARGIN.left + ((time - tMin) / (tMax - tMin)) * PLOT_WIDTH;
    const y = (value: number) => MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * PLOT_HEIGHT;

    const positions = points.map((point, index) => ({ x: x(times[index]!), y: y(point.value) }));

    // The range as a wash, broken wherever a result has none; a one-sided
    // range runs to the edge of the plot.
    const bands: string[] = [];
    let run: Array<{ x: number; top: number; bottom: number }> = [];
    const flush = () => {
      if (run.length === 1) {
        const only = run[0]!;
        bands.push(`M${only.x - 8},${only.top} H${only.x + 8} V${only.bottom} H${only.x - 8} Z`);
      } else if (run.length > 1) {
        const upper = run.map((step) => `${step.x},${step.top}`).join(' L');
        const lower = [...run]
          .reverse()
          .map((step) => `${step.x},${step.bottom}`)
          .join(' L');
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

    // Few date labels on a narrow screen: each result when there are up to
    // three, otherwise the ends and the middle.
    const dateTicks =
      points.length <= 3
        ? times.map((time) => ({ x: x(time), label: formatDate(new Date(time).toISOString()) }))
        : [0, 0.5, 1].map((fraction) => {
            const time = tMin + fraction * (tMax - tMin);
            return { x: x(time), label: formatDate(new Date(time).toISOString()) };
          });

    return { positions, ticks, y, bands, dateTicks };
  }, [points]);

  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || geometry.positions.length === 0) return;

    const pointerX = ((event.clientX - box.left) / box.width) * WIDTH;
    let found = 0;
    geometry.positions.forEach((position, index) => {
      if (Math.abs(position.x - pointerX) < Math.abs(geometry.positions[found]!.x - pointerX)) {
        found = index;
      }
    });
    setActive(found);
  };

  const activePoint = active === null ? null : points[active];
  const activePosition = active === null ? null : geometry.positions[active];
  const line = geometry.positions.map((position) => `${position.x},${position.y}`).join(' L');
  const last = geometry.positions[geometry.positions.length - 1];
  const lastPoint = points[points.length - 1];
  const withUnit = (value: number) => `${formatNumber(value)} ${analyte.unit}`;

  return (
    <figure className="trend">
      <figcaption className="muted">
        {t('trend.caption', { count: points.length, unit: analyte.unit })}
      </figcaption>

      <ul className="trend__legend" aria-label={t('trend.key')}>
        {geometry.bands.length > 0 ? (
          <li>
            <span className="trend__band-key" aria-hidden="true" /> {t('trend.bandKey')}
          </li>
        ) : null}
        <li>{t('trend.glyphKey')}</li>
      </ul>

      <div className="trend__plot" onPointerLeave={() => setActive(null)}>
        {/*
          A group, not an image: each reading below is focusable and named, and
          a role of `img` would hide them from a screen reader while leaving
          them in the tab order — which the portal's browser tests caught.
        */}
        <svg
          ref={svg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          aria-label={t('trend.chartLabel', { test: analyte.label })}
          onPointerMove={nearest}
          onPointerDown={nearest}
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
              <text
                x={MARGIN.left - 6}
                y={geometry.y(tick) + 4}
                textAnchor="end"
                className="trend__axis"
              >
                {formatNumber(tick)}
              </text>
            </g>
          ))}

          {geometry.dateTicks.map((tick, index) => (
            <text
              key={`${tick.label}-${index}`}
              x={tick.x}
              y={HEIGHT - 8}
              textAnchor={
                geometry.dateTicks.length > 1 && index === 0
                  ? 'start'
                  : index === geometry.dateTicks.length - 1 && geometry.dateTicks.length > 1
                    ? 'end'
                    : 'middle'
              }
              className="trend__axis"
            >
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
            const glyph =
              point.interpretation === 'high' ? '▲' : point.interpretation === 'low' ? '▼' : null;

            return (
              <g
                key={point.observationId}
                role="img"
                tabIndex={0}
                aria-label={t('trend.pointLabel', {
                  value: withUnit(point.value),
                  date: formatDateTime(point.collectedAt),
                  hospital: point.hospital.name,
                })}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className="trend__point"
              >
                <circle cx={position.x} cy={position.y} r={14} className="trend__hit" />
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={5}
                  className="trend__marker trend__marker--ringed"
                />
                {glyph ? (
                  <text
                    x={position.x}
                    y={position.y - 11}
                    textAnchor="middle"
                    className="trend__glyph"
                    aria-hidden="true"
                  >
                    {glyph}
                  </text>
                ) : null}
              </g>
            );
          })}

          {last && lastPoint ? (
            <text x={last.x + 10} y={last.y + 4} className="trend__end-label">
              {withUnit(lastPoint.value)}
            </text>
          ) : null}
        </svg>

        {activePoint && activePosition ? (
          <div
            className={`trend__tooltip${
              activePosition.x < WIDTH * 0.3
                ? ' trend__tooltip--start'
                : activePosition.x > WIDTH * 0.6
                  ? ' trend__tooltip--end'
                  : ''
            }`}
            style={{
              left: `${(activePosition.x / WIDTH) * 100}%`,
              top: `${(activePosition.y / HEIGHT) * 100}%`,
            }}
          >
            <strong>{withUnit(activePoint.value)}</strong>
            <span>{formatDateTime(activePoint.collectedAt)}</span>
            <span>{activePoint.hospital.name}</span>
            <Flag interpretation={activePoint.interpretation} />
          </div>
        ) : null}
      </div>

      <h2 className="trend__heading">{t('trend.every')}</h2>
      <ul className="items">
        {[...points].reverse().map((point) => (
          <li key={point.observationId}>
            <strong>{withUnit(point.value)}</strong>{' '}
            <Flag interpretation={point.interpretation} />
            <span className="item__detail">
              {rangeLabel(point.referenceLow, point.referenceHigh, analyte.unit) ??
                t('results.noRange')}
            </span>
            {point.unitAsEntered !== analyte.unit ? (
              <span className="item__meta">
                {t('trend.asReported', {
                  value: `${formatNumber(point.valueAsEntered)} ${point.unitAsEntered}`,
                })}
              </span>
            ) : null}
            <span className="item__meta">
              {formatDateTime(point.collectedAt)} · {point.hospital.name}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
