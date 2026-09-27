variable "region" {
  description = "Data residency is a legal requirement: India, and nowhere else."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = startswith(var.region, "ap-south-")
    error_message = "Patient data stays in India (planning.md §11); use an ap-south region."
  }
}

variable "environment" {
  description = "staging or production. Staging holds synthetic data only (DF1)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  description = "The private address range for everything in this environment."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "Two zones, because a single-zone database is not multi-AZ."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "database" {
  description = "The managed Postgres this environment runs on."
  type = object({
    instance_class           = string
    allocated_storage_gb     = number
    max_allocated_storage_gb = number
    multi_az                 = bool
    backup_retention_days    = number
    deletion_protection      = bool
  })

  default = {
    instance_class           = "db.t4g.small"
    allocated_storage_gb     = 50
    max_allocated_storage_gb = 400
    multi_az                 = true
    backup_retention_days    = 14
    deletion_protection      = true
  }
}

variable "cache_node_type" {
  description = "ElastiCache Redis, which the queues run on."
  type        = string
  default     = "cache.t4g.micro"
}

variable "api" {
  description = "How much of the API runs, and how big each task is."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
  })

  default = {
    cpu           = 512
    memory        = 1024
    desired_count = 2
  }
}

variable "worker" {
  description = "The worker: one task is enough until the queues say otherwise."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
  })

  default = {
    cpu           = 512
    memory        = 1024
    desired_count = 1
  }
}

variable "web" {
  description = "The two static apps, served by nginx."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
  })

  default = {
    cpu           = 256
    memory        = 512
    desired_count = 2
  }
}

variable "image_tag" {
  description = "The image every service runs. A deploy is a change to this."
  type        = string
  default     = "latest"
}

variable "log_retention_days" {
  description = <<-EOT
    How long operational logs are kept.

    Not the audit trail, which is a legal record kept in the database under its
    own retention (docs/observability.md). These are request lines and errors,
    and a month is long enough to investigate an incident.
  EOT
  type        = number
  default     = 30
}

variable "domain" {
  description = "Where the apps answer. Empty until DNS exists, which is fine."
  type = object({
    certificate_arn = string
    api             = string
    clinical        = string
    portal          = string
  })

  default = {
    certificate_arn = ""
    api             = ""
    clinical        = ""
    portal          = ""
  }
}

variable "office_cidrs" {
  description = "Addresses allowed to reach the load balancer at all, if any."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
