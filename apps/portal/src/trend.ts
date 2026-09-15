/** Clean tick values covering a range, for a chart's value axis. */
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
    [1, 2, 2.5, 5, 10]
      .map((multiple) => multiple * magnitude)
      .find((candidate) => (high - low) / candidate <= count) ?? 10 * magnitude;

  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= end + step / 1_000; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }

  return ticks;
}
