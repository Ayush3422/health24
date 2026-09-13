-- The last day of a medication course, inclusive.
--
-- One definition, used both to show a prescription's end date and to decide
-- whether it is still current, so the two can never disagree. A four-month
-- course starting 15 January ends on 14 May; an open-ended prescription has
-- no end date.
CREATE OR REPLACE FUNCTION app.medication_end_date(
  p_start date,
  p_value integer,
  p_unit duration_unit
) RETURNS date
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE
      WHEN p_value IS NULL OR p_unit IS NULL THEN NULL
      ELSE (
        p_start + CASE p_unit
          WHEN 'days' THEN make_interval(days => p_value)
          WHEN 'weeks' THEN make_interval(weeks => p_value)
          ELSE make_interval(months => p_value)
        END
      )::date - 1
    END
  $$;

GRANT EXECUTE ON FUNCTION app.medication_end_date(date, integer, duration_unit) TO health24_app;
