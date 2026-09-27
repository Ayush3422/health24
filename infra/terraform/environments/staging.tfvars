# Staging: synthetic data only, and never a copy of production (DF1).

environment = "staging"
vpc_cidr    = "10.40.0.0/16"

database = {
  instance_class           = "db.t4g.small"
  allocated_storage_gb     = 20
  max_allocated_storage_gb = 100
  # A single zone: what staging proves is that the deploy works, and paying
  # twice to prove it does not add anything.
  multi_az              = false
  backup_retention_days = 7
  deletion_protection   = false
}

cache_node_type = "cache.t4g.micro"

api    = { cpu = 512, memory = 1024, desired_count = 1 }
worker = { cpu = 512, memory = 1024, desired_count = 1 }
web    = { cpu = 256, memory = 512, desired_count = 1 }

log_retention_days = 14

# Filled in when DNS and a certificate exist.
domain = {
  certificate_arn = ""
  api             = "api.staging.health24.example"
  clinical        = "clinical.staging.health24.example"
  portal          = "portal.staging.health24.example"
}
