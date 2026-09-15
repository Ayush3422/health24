import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResultInterpretation } from '@health24/shared';
import { formatNumber } from '../format';

const GLYPH: Record<ResultInterpretation, string> = {
  high: '▲',
  low: '▼',
  abnormal: '!',
  normal: '',
};

/** Where a value stands against the lab's range: a glyph and words, never colour alone. */
export function Flag({
  interpretation,
}: {
  interpretation: ResultInterpretation | null;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (!interpretation) return null;

  return (
    <span className={`flag flag--${interpretation}`}>
      {GLYPH[interpretation] ? <span aria-hidden="true">{GLYPH[interpretation]} </span> : null}
      {t(`results.flag_${interpretation}`)}
    </span>
  );
}

/** "Lab's range 7–56 U/L", or null when the report printed none. */
export function useRangeLabel(): (
  low: number | null,
  high: number | null,
  unit: string,
) => string | null {
  const { t } = useTranslation();

  return useCallback(
    (low, high, unit) => {
      if (low !== null && high !== null) {
        return t('results.rangeBoth', { low: formatNumber(low), high: formatNumber(high), unit });
      }
      if (high !== null) return t('results.rangeBelow', { high: formatNumber(high), unit });
      if (low !== null) return t('results.rangeAbove', { low: formatNumber(low), unit });
      return null;
    },
    [t],
  );
}
