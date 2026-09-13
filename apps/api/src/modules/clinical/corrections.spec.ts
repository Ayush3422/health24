import { describe, expect, it } from 'vitest';
import { historyLabel } from './corrections.service';

describe('historyLabel', () => {
  it('names an untitled note by its template, not its key', () => {
    expect(historyLabel('notes', 'general')).toBe('Consultation (SOAP)');
    expect(historyLabel('notes', 'ayurveda_initial')).toBe('Ayurveda initial assessment');
  });

  it('keeps a note title as written', () => {
    expect(historyLabel('notes', 'First visit')).toBe('First visit');
  });

  it('leaves other kinds of entry alone', () => {
    expect(historyLabel('diagnoses', 'general')).toBe('general');
    expect(historyLabel('prescriptions', 'Pantoprazole 40 mg · 1-0-0 · active')).toBe(
      'Pantoprazole 40 mg · 1-0-0 · active',
    );
  });

  it('turns a missing label into an empty one', () => {
    expect(historyLabel('procedures', null)).toBe('');
  });
});
