# What a deploy and an operator need to know afterwards (sp7-plan.md, T16, T17).
#
# Nothing sensitive: names, hostnames and identifiers. A secret's ARN is a name,
# not a secret, and the value behind it never passes through Terraform (DF3).

output "cluster_name" {
  description = "The ECS cluster a deploy updates."
  value       = aws_ecs_cluster.this.name
}

output "service_names" {
  description = "Every service, for a deploy to wait on."
  value = {
    api      = aws_ecs_service.api.name
    worker   = aws_ecs_service.worker.name
    clinical = aws_ecs_service.web["clinical"].name
    portal   = aws_ecs_service.web["portal"].name
    clamav   = aws_ecs_service.clamav.name
  }
}

output "migrate_task_definition" {
  description = "The task a deploy runs, and waits for, before updating the services."
  value       = aws_ecs_task_definition.migrate.family
}

output "task_network" {
  description = "Where a one-off task — a migration, a restore drill — has to run."
  value = {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
}

output "repositories" {
  description = "Where the images are pushed."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "load_balancer_hostname" {
  description = "What the DNS records point at."
  value       = aws_lb.this.dns_name
}

output "database_endpoint" {
  description = "The database's address. The credentials are in Secrets Manager."
  value       = aws_db_instance.this.address
}

output "database_master_secret_arn" {
  description = <<-EOT
    Where AWS keeps the owner's generated password.

    A person reads it once, builds the two connection URLs from it — the
    owner's for the migration job, and the application's unprivileged one —
    and puts those in the secrets below. Nothing automates that, on purpose.
  EOT
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "secret_arns" {
  description = "The secrets a person fills in once. Values are never in Terraform."
  value       = { for key, secret in aws_secretsmanager_secret.app : key => secret.arn }
}

output "documents_bucket" {
  description = "Where documents and rendered PDFs live."
  value       = aws_s3_bucket.documents.bucket
}

output "alerts_topic_arn" {
  description = "Subscribe a person to this by hand; people change without a Terraform run."
  value       = aws_sns_topic.alerts.arn
}
