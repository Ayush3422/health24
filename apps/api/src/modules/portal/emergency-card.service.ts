import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import {
  EMERGENCY_CARD_FIELDS,
  type EmergencyCardField,
  type EmergencyCardSettings,
  type EmergencyFacts,
  type EmergencyPage,
  type PortalEmergencyCard,
  type PortalEmergencyCardState,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../../common/crypto';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { emergencyCards } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { toIso, violatedConstraint } from '../clinical/clinical-access';
import { PortalRecordService, type RecordEssentials } from './portal-record.service';

type CardRow = {
  id: string;
  fields: EmergencyCardField[];
  token_encrypted: string;
  created_at: string | Date;
  updated_at: string | Date;
};

/** A link's token: 32 random bytes, base64url. Anything else is not worth a lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The same answer for a mistyped, revoked or never-issued link. */
const NOT_IN_USE = 'This emergency card is not in use';

/**
 * The emergency card (sp5-plan.md, Decision L1).
 *
 * The patient chooses what the card shows; the card prints those facts, and
 * its QR code opens a page with the same facts, kept current. The link is a
 * long random token the patient can replace or turn off. Every opening is
 * audited against the patient, so it appears in their access history.
 */
@Injectable()
export class EmergencyCardService {
  /** The key that encrypts TOTP secrets at rest also keeps card links unreadable in a dump. */
  private readonly key: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly record: PortalRecordService,
    config: ConfigService,
  ) {
    this.key = config.getOrThrow<string>('TOTP_ENCRYPTION_KEY');
  }

  async state(patient: PatientActor, meta: RequestMeta): Promise<PortalEmergencyCardState> {
    const card = await this.db.asPatient(patient.patientId, (tx) => this.current(tx));
    const essentials = await this.record.essentials(patient.patientId);

    await this.audit.recordForPatient(patient, {
      resourceType: 'emergency_card',
      resourceId: card?.id ?? null,
      action: 'read',
      meta,
    });

    return {
      card: card ? this.toCard(card) : null,
      facts: this.toFacts(essentials, EMERGENCY_CARD_FIELDS),
    };
  }

  async create(
    patient: PatientActor,
    settings: EmergencyCardSettings,
    meta: RequestMeta,
  ): Promise<PortalEmergencyCard> {
    const card = await this.db
      .asPatient(patient.patientId, async (tx) => {
        if (await this.current(tx)) {
          throw new ConflictException(
            'You already have an emergency card. Replace it if you need a new link.',
          );
        }

        return this.issue(tx, patient, settings.fields);
      })
      .catch((error: unknown) => {
        throw violatedConstraint(error) === 'emergency_card_one_in_use'
          ? new ConflictException('You already have an emergency card')
          : error;
      });

    await this.audit.recordForPatient(patient, {
      resourceType: 'emergency_card',
      resourceId: card.id,
      action: 'create',
      meta,
    });

    return this.toCard(card);
  }

  /** Changes what the card shows. The link stays the same, so a printed card keeps working. */
  async update(
    patient: PatientActor,
    settings: EmergencyCardSettings,
    meta: RequestMeta,
  ): Promise<PortalEmergencyCard> {
    const card = await this.db.asPatient(patient.patientId, async (tx) => {
      const current = await this.requireCurrent(tx);

      await tx.execute(sql`
        UPDATE "emergency_card"
           SET "fields" = ${this.fieldsArray(settings.fields)}, "updated_at" = now()
         WHERE "id" = ${current.id}::uuid
      `);

      return this.requireCurrent(tx);
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'emergency_card',
      resourceId: card.id,
      action: 'update',
      meta,
    });

    return this.toCard(card);
  }

  /** For a lost card: the old link stops working at once, and a new card shows the same facts. */
  async replace(patient: PatientActor, meta: RequestMeta): Promise<PortalEmergencyCard> {
    const card = await this.db.asPatient(patient.patientId, async (tx) => {
      const current = await this.requireCurrent(tx);
      await this.revokeRow(tx, current.id, patient.accountId);
      return this.issue(tx, patient, current.fields);
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'emergency_card',
      resourceId: card.id,
      action: 'update',
      meta,
    });

    return this.toCard(card);
  }

  async revoke(patient: PatientActor, meta: RequestMeta): Promise<void> {
    const id = await this.db.asPatient(patient.patientId, async (tx) => {
      const current = await this.requireCurrent(tx);
      await this.revokeRow(tx, current.id, patient.accountId);
      return current.id;
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'emergency_card',
      resourceId: id,
      action: 'update',
      meta,
    });
  }

  /**
   * The page a card's QR code opens, for whoever holds the card: the chosen
   * facts as they stand now. Audited as a read of the patient's record.
   */
  async open(token: string, meta: RequestMeta): Promise<EmergencyPage> {
    if (!TOKEN_SHAPE.test(token)) throw new NotFoundException(NOT_IN_USE);

    // No context at all: row-level security admits nothing, and the one
    // function built for this lookup finds the card in use for the token.
    const [card] = await this.db.raw.execute<{
      card_id: string;
      card_patient_id: string;
      card_fields: EmergencyCardField[];
      card_updated_at: string | Date;
    }>(sql`SELECT * FROM app.emergency_card_for_token(${hashToken(token)})`);

    if (!card) throw new NotFoundException(NOT_IN_USE);

    const essentials = await this.record.essentials(card.card_patient_id);

    await this.audit.record({
      actorId: null,
      actorType: 'system',
      actorLabel: 'emergency card',
      hospitalId: null,
      patientId: card.card_patient_id,
      resourceType: 'emergency_card',
      resourceId: card.card_id,
      action: 'read',
      meta,
    });

    return {
      facts: this.toFacts(essentials, card.card_fields),
      cardUpdatedAt: toIso(card.card_updated_at),
    };
  }

  private async issue(
    tx: DbTransaction,
    patient: PatientActor,
    fields: readonly EmergencyCardField[],
  ): Promise<CardRow> {
    const token = generateToken(32);

    const [created] = await tx
      .insert(emergencyCards)
      .values({
        patientId: patient.patientId,
        tokenHash: hashToken(token),
        tokenEncrypted: encryptSecret(token, this.key),
        fields: [...fields],
        createdByAccountId: patient.accountId,
      })
      .returning({ id: emergencyCards.id });

    if (!created) throw new Error('Failed to issue the emergency card');

    return this.requireCurrent(tx);
  }

  private async revokeRow(tx: DbTransaction, id: string, accountId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE "emergency_card"
         SET "revoked_at" = now(), "revoked_by_account_id" = ${accountId}::uuid
       WHERE "id" = ${id}::uuid
    `);
  }

  /** The card in use, under row-level security: only ever the patient's own. */
  private async current(tx: DbTransaction): Promise<CardRow | null> {
    const [row] = await tx.execute<CardRow>(sql`
      SELECT "id", "fields", "token_encrypted", "created_at", "updated_at"
        FROM "emergency_card"
       WHERE "revoked_at" IS NULL
         AND "patient_id" = app.current_patient_id()
    `);

    return row ?? null;
  }

  private async requireCurrent(tx: DbTransaction): Promise<CardRow> {
    const card = await this.current(tx);
    if (!card) throw new NotFoundException('You have no emergency card in use');
    return card;
  }

  private fieldsArray(fields: readonly EmergencyCardField[]) {
    return sql`ARRAY[${sql.join(
      fields.map((field) => sql`${field}`),
      sql`, `,
    )}]::text[]`;
  }

  private toCard(row: CardRow): PortalEmergencyCard {
    return {
      id: row.id,
      // In the order the portal lists them, whatever order they were chosen in.
      fields: EMERGENCY_CARD_FIELDS.filter((field) => row.fields.includes(field)),
      token: decryptSecret(row.token_encrypted, this.key),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private toFacts(
    essentials: RecordEssentials,
    fields: readonly EmergencyCardField[],
  ): EmergencyFacts {
    const shows = (field: EmergencyCardField) => fields.includes(field);

    return {
      name: essentials.name,
      ageYears: essentials.ageYears,
      ...(shows('blood_group') ? { bloodGroup: essentials.bloodGroup } : {}),
      ...(shows('allergies')
        ? {
            allergies: essentials.allergies.map(({ substance, highRisk, reaction }) => ({
              substance,
              highRisk,
              reaction,
            })),
          }
        : {}),
      ...(shows('medicines')
        ? { medicines: essentials.medicines.map(({ name, howToTake }) => ({ name, howToTake })) }
        : {}),
      ...(shows('conditions')
        ? { conditions: essentials.problems.map(({ name, code }) => ({ name, code })) }
        : {}),
      ...(shows('emergency_contact') ? { emergencyContact: essentials.emergencyContact } : {}),
    };
  }
}
