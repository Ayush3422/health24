import type { EmergencyCardField, EmergencyFacts } from '@health24/shared';

/** The fields, in the order the card and the settings list them. */
export const CARD_FIELDS: readonly EmergencyCardField[] = [
  'blood_group',
  'allergies',
  'medicines',
  'conditions',
  'emergency_contact',
];

/** The facts a card shows, from the preview of every field. */
export function pickFacts(facts: EmergencyFacts, fields: readonly EmergencyCardField[]): EmergencyFacts {
  const shows = (field: EmergencyCardField) => fields.includes(field);

  return {
    name: facts.name,
    ageYears: facts.ageYears,
    ...(shows('blood_group') ? { bloodGroup: facts.bloodGroup ?? null } : {}),
    ...(shows('allergies') ? { allergies: facts.allergies ?? [] } : {}),
    ...(shows('medicines') ? { medicines: facts.medicines ?? [] } : {}),
    ...(shows('conditions') ? { conditions: facts.conditions ?? [] } : {}),
    ...(shows('emergency_contact') ? { emergencyContact: facts.emergencyContact ?? null } : {}),
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The lines of a lock-screen image: what a stranger holding the phone most
 * needs, allergies first. Names nothing the patient did not choose.
 */
export function lockScreenLines(facts: EmergencyFacts, t: Translate): string[] {
  const lines: string[] = [];

  if (facts.allergies && facts.allergies.length > 0) {
    lines.push(
      t('emergencyCard.lineAllergies', {
        list: facts.allergies
          .map((allergy) => (allergy.highRisk ? `${allergy.substance} (${t('emergencyCard.highRisk')})` : allergy.substance))
          .join(', '),
      }),
    );
  }
  if (facts.bloodGroup) lines.push(t('emergencyCard.lineBloodGroup', { value: facts.bloodGroup }));
  if (facts.conditions && facts.conditions.length > 0) {
    lines.push(t('emergencyCard.lineConditions', { list: facts.conditions.map((item) => item.name).join(', ') }));
  }
  if (facts.medicines && facts.medicines.length > 0) {
    lines.push(t('emergencyCard.lineMedicines', { list: facts.medicines.map((item) => item.name).join(', ') }));
  }
  if (facts.emergencyContact) {
    lines.push(
      t('emergencyCard.lineContact', {
        name: facts.emergencyContact.name,
        phone: facts.emergencyContact.phone,
      }),
    );
  }

  return lines;
}

/** Draws a 1080×1920 lock-screen image: space for the clock above, the facts and the QR code below. */
export function drawLockScreen(
  canvas: HTMLCanvasElement,
  text: { title: string; name: string; lines: string[]; footer: string },
  qr: HTMLCanvasElement,
): void {
  const width = 1080;
  const height = 1920;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) return;

  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const left = 110;
  const panelTop = 720;
  const qrSize = 340;

  context.fillStyle = '#14532d';
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#ffffff';
  context.beginPath();
  context.roundRect(60, panelTop, width - 120, height - panelTop - 80, 36);
  context.fill();

  context.fillStyle = '#8c1d18';
  context.font = `bold 46px ${font}`;
  context.fillText(text.title, left, panelTop + 90, width - 2 * left);

  context.fillStyle = '#17202a';
  context.font = `bold 66px ${font}`;
  context.fillText(text.name, left, panelTop + 180, width - 2 * left);

  // Wrapped lines, stopping above the QR code.
  context.font = `40px ${font}`;
  const limit = height - 140 - qrSize - 40;
  let y = panelTop + 270;

  for (const line of text.lines) {
    const words = line.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width > width - 2 * left && current) {
        if (y > limit) break;
        context.fillText(current, left, y);
        y += 54;
        current = word;
      } else {
        current = candidate;
      }
    }

    if (y > limit) break;
    context.fillText(current, left, y);
    y += 70;
  }

  context.drawImage(qr, width - left - qrSize, height - 140 - qrSize, qrSize, qrSize);

  context.fillStyle = '#4f5b67';
  context.font = `32px ${font}`;
  context.fillText(text.footer, left, height - 150, width - 2 * left - qrSize - 40);
}
