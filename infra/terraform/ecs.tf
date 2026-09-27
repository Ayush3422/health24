# What runs, and how it finds the rest (sp7-plan.md, T16).
#
# Fargate, because a hospital-sized deployment has no business paying somebody
# to patch instances. Five services: the API, the worker, the two apps — and
# the scanner, which is a dependency of every upload rather than an optional
# extra (SP4).

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  # Nothing a clinician waits on runs on a task that can be taken away.
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# Internal DNS, so the API can reach the scanner by name without either of them
# knowing an address.
resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.environment}.health24.internal"
  description = "How the tasks find each other"
  vpc         = aws_vpc.this.id
}

resource "aws_service_discovery_service" "clamav" {
  name = "clamav"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["api", "worker", "clinical", "portal", "clamav", "migrate"])

  name              = "/health24/${var.environment}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.secrets.arn
}

# ---------------------------------------------------------------------------
# What every task is told
# ---------------------------------------------------------------------------

locals {
  registry = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }

  # Configuration, which is not secret and is therefore plainly visible here.
  api_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "LOG_FORMAT", value = "json" },
    { name = "LOG_LEVEL", value = var.environment == "production" ? "info" : "debug" },
    { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379" },
    { name = "STORAGE_BUCKET", value = aws_s3_bucket.documents.bucket },
    { name = "STORAGE_REGION", value = var.region },
    { name = "CLAMAV_HOST", value = "clamav.${aws_service_discovery_private_dns_namespace.this.name}" },
    { name = "TOTP_ISSUER", value = "Health24" },
    {
      name = "CORS_ORIGINS"
      value = join(",", compact([
        var.domain.clinical != "" ? "https://${var.domain.clinical}" : "",
        var.domain.portal != "" ? "https://${var.domain.portal}" : "",
      ]))
    },
  ]

  # Secrets, by reference: the value never passes through Terraform.
  #
  # Two exclusions, both deliberate. The `_PREVIOUS` pair is attached only while
  # a rotation is running (docs/runbooks/key-rotation.md), because an empty
  # secret stops a task starting and three in the morning is the wrong time to
  # find that out. And the owner's database connection is never given to the
  # application at all — production refuses to start with it (T2), and the
  # migration task is the only thing that holds it.
  api_secrets = [
    for key, variable in local.app_secrets : {
      name      = variable
      valueFrom = aws_secretsmanager_secret.app[key].arn
    }
    if !endswith(key, "_previous") && key != "owner_database_url"
  ]
}

# ---------------------------------------------------------------------------
# The API
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api.cpu
  memory                   = var.api.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${local.registry["api"]}:${var.image_tag}"
      essential = true

      portMappings = [{ containerPort = 3000, protocol = "tcp" }]

      environment = local.api_environment
      secrets     = local.api_secrets

      # The container's own check is liveness; the load balancer asks /ready,
      # which is the different question (DF6).
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["api"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }

      readonlyRootFilesystem = true
      linuxParameters        = { initProcessEnabled = true }
    },
  ])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
    # Images come through the NAT gateway; the task itself has no address.
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  # A task is given time to finish what it is serving: a clinician's save is not
  # worth losing to a deploy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  enable_execute_command = var.environment != "production"

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker.cpu
  memory                   = var.worker.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${local.registry["api"]}:${var.image_tag}"
      essential = true
      command   = ["node", "dist/worker.js"]

      portMappings = [{ containerPort = 3100, protocol = "tcp" }]

      environment = concat(local.api_environment, [
        { name = "WORKER_PORT", value = "3100" },
      ])
      secrets = local.api_secrets

      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:3100/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["worker"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }

      readonlyRootFilesystem = true
    },
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # No load balancer: nothing outside reaches the worker. Its queues are its
  # inbox, and its probe port is scraped from inside the VPC.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ---------------------------------------------------------------------------
# The two apps
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  for_each = toset(["clinical", "portal"])

  family                   = "${local.name}-${each.value}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web.cpu
  memory                   = var.web.memory
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name      = each.value
      image     = "${local.registry[each.value]}:${var.image_tag}"
      essential = true

      portMappings = [{ containerPort = 8080, protocol = "tcp" }]

      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service[each.value].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = each.value
        }
      }

      # nginx writes its temporary files to /tmp, which is a volume rather than
      # a writable root.
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    },
  ])

  volume {
    name = "tmp"
  }
}

resource "aws_ecs_service" "web" {
  for_each = aws_ecs_task_definition.web

  name            = each.key
  cluster         = aws_ecs_cluster.this.id
  task_definition = each.value.arn
  desired_count   = var.web.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web[each.key].arn
    container_name   = each.key
    container_port   = 8080
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------------------
# The scanner
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "clamav" {
  family                   = "${local.name}-clamav"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # The signature database is held in memory, which is why this asks for more
  # than the API does.
  cpu                = 512
  memory             = 2048
  execution_role_arn = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name      = "clamav"
      image     = "clamav/clamav:1.4"
      essential = true

      portMappings = [{ containerPort = 3310, protocol = "tcp" }]

      healthCheck = {
        command  = ["CMD-SHELL", "clamdscan --ping 1 || exit 1"]
        interval = 30
        timeout  = 10
        retries  = 5
        # The first start downloads the signatures, which takes minutes.
        startPeriod = 300
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["clamav"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "clamav"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "clamav" {
  name            = "clamav"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.clamav.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.clamav.arn
  }

  # One scanner, replaced rather than doubled: an upload waits for its scan, and
  # waiting is the correct behaviour (SP4).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
}

# ---------------------------------------------------------------------------
# Migrations, as a task somebody runs
# ---------------------------------------------------------------------------

# Registered but never started by Terraform. A deploy runs this task and waits
# for it to exit before the services are updated — see
# `.github/workflows/deploy.yml` and `docs/deployment.md`. It is the only thing
# in the account that holds the database owner's credentials.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = "${local.registry["api"]}:${var.image_tag}"
      essential = true
      command   = ["node", "dist/db/migrate.js"]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "LOG_FORMAT", value = "json" },
      ]

      secrets = [
        {
          name      = "DATABASE_ADMIN_URL"
          valueFrom = aws_secretsmanager_secret.app["owner_database_url"].arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["migrate"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "migrate"
        }
      }

      readonlyRootFilesystem = true
    },
  ])
}
