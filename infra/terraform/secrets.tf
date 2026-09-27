# Secrets: their names, and who may read them (sp7-plan.md, T16, DF3).
#
# Values are never here. Terraform creates each secret empty and a person puts
# the value in once, through the console or the CLI; `terraform plan` on a
# fresh checkout prints no secret because there is none to print. The
# application reads its environment, not Secrets Manager, so the same image
# runs unchanged on a laptop and in production (docs/secrets.md).

locals {
  # The signing secret and the encryption key, each with the `_PREVIOUS`
  # partner a rotation needs (docs/runbooks/key-rotation.md).
  app_secrets = {
    jwt_access_secret            = "JWT_ACCESS_SECRET"
    jwt_access_secret_previous   = "JWT_ACCESS_SECRET_PREVIOUS"
    totp_encryption_key          = "TOTP_ENCRYPTION_KEY"
    totp_encryption_key_previous = "TOTP_ENCRYPTION_KEY_PREVIOUS"
    # The application's own connection, as the unprivileged role. The owner's
    # is separate and belongs to the migration job alone.
    app_database_url         = "DATABASE_URL"
    owner_database_url       = "DATABASE_ADMIN_URL"
    sms_provider_credentials = "SMS_PROVIDER_CREDENTIALS"
  }
}

resource "aws_kms_key" "secrets" {
  description             = "${local.name} application secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name       = "${local.name}/${each.key}"
  kms_key_id = aws_kms_key.secrets.arn

  description = "${each.value} for ${local.name}. Set by hand; never in Terraform."

  # A secret deleted by accident is recoverable for a week, which is the
  # difference between a bad afternoon and re-enrolling every second factor.
  recovery_window_in_days = 7
}

# Deliberately no `aws_secretsmanager_secret_version` resources. Writing one
# would put the value in state, and state is a file in a bucket that more
# people can read than can read Secrets Manager.
