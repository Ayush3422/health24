import { describe, expect, it } from 'vitest';
import { lockScreenLines, pickFacts } from './emergency';

const facts = {
  name: 'Lakshmi',
  ageYears: 58,
  bloodGroup: 'B+',
  allergies: [{ substance: 'Penicillin', highRisk: true, reaction: 'Hives' }],
  medicines: [{ name: 'Avipattikar churna 5 g', howToTake: '1-0-1' }],
  conditions: [{ name: 'Amlapitta', code: 'NAM-1' }],
  emergencyContact: { name: 'Ravi', phone: '+919820012345' },
};

const t = (key: string, options?: Record<string, unknown>) =>
  `${key}${options ? ` ${JSON.stringify(options)}` : ''}`;

describe('the emergency card', () => {
  it('shows only what the patient chose, with name and age always', () => {
    expect(pickFacts(facts, ['allergies'])).toEqual({
      name: 'Lakshmi',
      ageYears: 58,
      allergies: facts.allergies,
    });
  });

  it('puts allergies first on the lock screen, and nothing that was not chosen', () => {
    const lines = lockScreenLines(pickFacts(facts, ['blood_group', 'allergies']), t);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('lineAllergies');
    expect(lines[0]).toContain('Penicillin');
    expect(lines.join(' ')).not.toContain('Avipattikar');
  });
});
