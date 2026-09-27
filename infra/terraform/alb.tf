# How a request reaches the right service (sp7-plan.md, T16).
#
# One load balancer, three host names: the API, the clinical app and the
# portal. HTTP exists only to redirect to HTTPS, and the API's target group
# asks `/ready` rather than `/health` — a task that cannot reach its database
# should be taken out of rotation, not merely restarted (DF6).

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # A slow clinician is not a dropped one: an upload of a scanned report over a
  # hospital's connection can take a while.
  idle_timeout = 120

  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"

  # The balancer's own access log, which carries paths — and a path carries a
  # patient's id. Kept in the documents bucket's account under its own prefix,
  # with the same retention as the logs, and never in a third party's tool.
  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb"
    enabled = true
  }

  tags = { Name = local.name }
}

resource "aws_s3_bucket" "logs" {
  bucket        = "${local.name}-logs"
  force_destroy = var.environment != "production"

  tags = { Name = "${local.name}-logs" }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {}

    expiration {
      days = var.log_retention_days
    }
  }
}

# The load balancer writes with a service principal, not a role of ours.
data "aws_elb_service_account" "this" {}

data "aws_iam_policy_document" "logs_bucket" {
  statement {
    sid    = "AllowTheLoadBalancerToWrite"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/alb/*"]
  }

  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs_bucket.json
}

# ---------------------------------------------------------------------------
# Where requests go
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  # Readiness, deliberately: a task whose database, queue or storage is
  # unreachable answers 503 here and is sent nothing (DF6).
  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # A deploy drains rather than cuts: fifteen seconds is longer than any
  # request this API serves.
  deregistration_delay = 15
}

resource "aws_lb_target_group" "web" {
  for_each = toset(["clinical", "portal"])

  name        = "${local.name}-${each.value}"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 10
}

# ---------------------------------------------------------------------------
# Listeners
# ---------------------------------------------------------------------------

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 and above, which is what the DPDP Act's "reasonable security
  # safeguards" means in practice today.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.domain.certificate_arn

  # Anything that matches no rule below is refused rather than sent somewhere.
  # A misrouted clinical request is worse than a failed one.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [var.domain.api]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  for_each = {
    clinical = { priority = 20, host = var.domain.clinical }
    portal   = { priority = 30, host = var.domain.portal }
  }

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[each.key].arn
  }

  condition {
    host_header {
      values = [each.value.host]
    }
  }
}

# The apps call the API at `/api` on their own origin, which is what keeps the
# browser same-origin and the tokens out of a cross-origin request (T13). The
# balancer does that routing, so the app containers never proxy anything.
resource "aws_lb_listener_rule" "app_api_path" {
  for_each = {
    clinical = { priority = 5, host = var.domain.clinical }
    portal   = { priority = 6, host = var.domain.portal }
  }

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [each.value.host]
    }
  }

  condition {
    path_pattern {
      values = ["/api/*", "/health", "/ready", "/version"]
    }
  }
}
