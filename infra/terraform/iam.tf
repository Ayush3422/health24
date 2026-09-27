# What each task may do (sp7-plan.md, T16).
#
# Two roles per service, because they answer different questions: the execution
# role is what ECS needs to *start* the container (pull the image, fetch the
# secrets it injects, write the log stream), and the task role is what the code
# itself may do once running. Keeping them apart is what stops application code
# being able to read every secret in the account.

data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadTheSecretsItInjects"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for secret in aws_secretsmanager_secret.app : secret.arn]
  }

  statement {
    sid       = "ReadTheDatabaseMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.this.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "DecryptThem"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn, aws_kms_key.database.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---------------------------------------------------------------------------
# What the application itself may do
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

# The documents bucket, and nothing else in the account. No `s3:DeleteObject`:
# a document is withdrawn by marking it, and an erasure is a deliberate act
# with its own path (SP5) — not something an application bug can do by looping.
data "aws_iam_policy_document" "documents_access" {
  statement {
    sid    = "ReadAndWriteDocuments"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]

    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }

  statement {
    sid       = "FindThemInTheBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.documents.arn]
  }

  statement {
    sid       = "UseTheBucketKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.documents.arn]
  }
}

resource "aws_iam_role_policy" "api_documents" {
  name   = "documents"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.documents_access.json
}

resource "aws_iam_role_policy" "worker_documents" {
  name   = "documents"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.documents_access.json
}

# The erasure path is the worker's, and it is the only thing that may remove an
# object. Separated from the policy above so that the grant is visible: this is
# a patient exercising a right under the DPDP Act (sp5-plan.md, Decision N1).
data "aws_iam_policy_document" "worker_erasure" {
  statement {
    sid       = "ErasePatientDocumentsWhenRequired"
    effect    = "Allow"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }
}

resource "aws_iam_role_policy" "worker_erasure" {
  name   = "erasure"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_erasure.json
}
