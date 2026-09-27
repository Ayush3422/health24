# Pinned deliberately: infrastructure that changes because a provider released
# a minor version is infrastructure nobody can reason about (sp7-plan.md, T16).

terraform {
  required_version = "~> 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # State lives in S3 with a DynamoDB lock table, both created once by hand
  # before the first apply — a backend cannot create its own storage. The
  # values are supplied at init time so that this file holds no account
  # identifiers:
  #
  #   terraform init \
  #     -backend-config="bucket=health24-tfstate" \
  #     -backend-config="key=staging/terraform.tfstate" \
  #     -backend-config="region=ap-south-1" \
  #     -backend-config="dynamodb_table=health24-tfstate-lock" \
  #     -backend-config="encrypt=true"
  #
  # CI validates with `-backend=false`, which needs no account at all.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "health24"
      Environment = var.environment
      ManagedBy   = "terraform"
      # A hospital's data is personal data under the DPDP Act; anything holding
      # it is tagged so that an inventory can be produced without guesswork.
      DataClass = "phi"
    }
  }
}
