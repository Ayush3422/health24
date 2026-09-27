# Where the images live (sp7-plan.md, T16, T17).

locals {
  images = ["api", "clinical", "portal"]
}

resource "aws_ecr_repository" "this" {
  for_each = toset(local.images)

  name                 = "health24/${each.value}"
  image_tag_mutability = "IMMUTABLE"

  # Scanned when pushed, so a base image with a new advisory is found without
  # anybody remembering to look (T24).
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last thirty images; a rollback never needs more."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}
