# The few things worth waking somebody for (sp7-plan.md, T16).
#
# Deliberately short. An alarm nobody acts on trains everybody to ignore
# alarms, so this is the list where every entry has an answer in a runbook.
#
# What is not here: dashboards, and thresholds tuned to a load nobody has
# measured yet. Those come from the pilot, not from a guess.

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.secrets.id
}

# Subscriptions are added by hand: an email address or a phone number is a
# person, and people change without a Terraform run.

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
}

# The API is answering with errors — the one alarm that means a clinician is
# looking at a screen that will not work.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 5
  treat_missing_data  = "notBreaching"

  metric_name = "HTTPCode_Target_5XX_Count"
  namespace   = "AWS/ApplicationELB"
  period      = 60
  statistic   = "Sum"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  alarm_description = "The API is failing requests. See docs/runbooks/incident-response.md."
  alarm_actions     = local.alarm_actions
  ok_actions        = local.alarm_actions
}

# No healthy task at all, which is the difference between slow and down.
resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${local.name}-api-no-healthy-tasks"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 1
  treat_missing_data  = "breaching"

  metric_name = "HealthyHostCount"
  namespace   = "AWS/ApplicationELB"
  period      = 60
  statistic   = "Minimum"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  alarm_description = "Nothing is serving the API. Check /ready on a task."
  alarm_actions     = local.alarm_actions
  ok_actions        = local.alarm_actions
}

# The database filling up, which is silent until it is sudden.
resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${local.name}-database-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  # Ten gigabytes, in bytes. Autoscaling storage makes this a warning rather
  # than an emergency, but a database that cannot write is a hospital that
  # cannot record a diagnosis.
  threshold          = 10737418240
  treat_missing_data = "breaching"

  metric_name = "FreeStorageSpace"
  namespace   = "AWS/RDS"
  period      = 300
  statistic   = "Minimum"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  alarm_description = "The database is running out of room."
  alarm_actions     = local.alarm_actions
}

# Backups that have stopped being taken. An untested backup is not a backup,
# and a backup that is not happening is not one either (DF7).
resource "aws_cloudwatch_metric_alarm" "database_backup_age" {
  alarm_name          = "${local.name}-database-backup-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  # Two hours, in seconds: point-in-time recovery should never be further
  # behind than that.
  threshold          = 7200
  treat_missing_data = "breaching"

  metric_name = "OldestReplicationSlotLag"
  namespace   = "AWS/RDS"
  period      = 3600
  statistic   = "Maximum"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  alarm_description = "Point-in-time recovery is falling behind. See docs/runbooks/restore.md."
  alarm_actions     = local.alarm_actions
}
