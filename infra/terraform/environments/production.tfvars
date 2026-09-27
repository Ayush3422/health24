# Production: the only place a real patient record exists.

environment = "production"
vpc_cidr    = "10.50.0.0/16"

database = {
  instance_class           = "db.t4g.medium"
  allocated_storage_gb     = 100
  max_allocated_storage_gb = 1000
  multi_az                 = true
  # Two weeks of point-in-time recovery. Longer is a retention decision that
  # counsel has to make, not an infrastructure preference (docs/compliance).
  backup_retention_days = 14
  deletion_protection   = true
}

cache_node_type = "cache.t4g.small"

# Two API tasks, so a deploy and a zone failure are both survivable.
api    = { cpu = 1024, memory = 2048, desired_count = 2 }
worker = { cpu = 512, memory = 1024, desired_count = 1 }
web    = { cpu = 256, memory = 512, desired_count = 2 }

log_retention_days = 30

domain = {
  certificate_arn = ""
  api             = "api.health24.example"
  clinical        = "clinical.health24.example"
  portal          = "portal.health24.example"
}
