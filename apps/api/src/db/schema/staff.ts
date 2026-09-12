import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { hospitals } from './hospitals';
import { staffRoleEnum, systemOfMedicineEnum, userStatusEnum } from './enums';

/**
 * A staff member of a hospital, or — when `hospitalId` is null — a Health24
 * platform administrator.
 */
export const staffUsers = pgTable(
  'staff_user',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    /** Null only for platform admins, who belong to no tenant. */
    hospitalId: uuid('hospital_id').references(() => hospitals.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone'),

    /** Null until the invitation is accepted and a password is set. */
    passwordHash: text('password_hash'),

    role: staffRoleEnum('role').notNull(),

    /** The system a clinician practises. Null for non-clinical roles. */
    systemOfMedicine: systemOfMedicineEnum('system_of_medicine'),

    /** ABDM Healthcare Professional Registry ID. */
    hprId: text('hpr_id'),

    status: userStatusEnum('status').notNull().default('invited'),

    /**
     * TOTP shared secret. Stored encrypted at the application layer before it
     * reaches this column — see TotpService.
     */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),

    /** Argon2 hashes of single-use recovery codes, consumed on use. */
    recoveryCodeHashes: text('recovery_code_hashes').array(),

    /** Invitation is a hashed single-use token with an expiry. */
    inviteTokenHash: text('invite_token_hash'),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),

    /** Brute-force protection. */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_user_hospital_idx').on(table.hospitalId)],
);

export type StaffUser = typeof staffUsers.$inferSelect;
export type NewStaffUser = typeof staffUsers.$inferInsert;

/**
 * An active sign-in.
 *
 * Refresh tokens are opaque and stored hashed, so a database leak does not hand
 * an attacker live sessions, and so a session can be revoked server-side the
 * instant a device is lost. A stateless-JWT-only design cannot do the latter,
 * which rules it out for a clinical system.
 */
export const sessions = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),

    refreshTokenHash: text('refresh_token_hash').notNull().unique(),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('session_staff_user_idx').on(table.staffUserId)],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
