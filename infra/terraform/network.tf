# The network everything sits in (sp7-plan.md, T16).
#
# Two zones; the database and every task in private subnets; the load balancer
# the only thing with a public address. Nothing that holds patient data has a
# route from the internet, which is the property this file exists to create.

locals {
  name = "health24-${var.environment}"

  # /20 per zone for tasks, /24 per zone for the load balancer and the database.
  private_subnets = [for index, az in var.availability_zones : cidrsubnet(var.vpc_cidr, 4, index)]
  public_subnets  = [for index, az in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, index + 200)]
  data_subnets    = [for index, az in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, index + 220)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = local.name }
}

resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_subnets[count.index]
  availability_zone = var.availability_zones[count.index]

  # Only the load balancer lives here, and it is given its address explicitly.
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public-${var.availability_zones[count.index]}" }
}

resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "${local.name}-private-${var.availability_zones[count.index]}" }
}

resource "aws_subnet" "data" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_subnets[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "${local.name}-data-${var.availability_zones[count.index]}" }
}

# One NAT gateway rather than one per zone. It is the difference between about
# thirty dollars a month and ninety, and what it costs in a zone failure is
# outbound internet access — which the tasks use for nothing a patient waits
# on. Production may want two; the variable to change is this count.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  depends_on = [aws_internet_gateway.this]

  tags = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = { Name = "${local.name}-private" }
}

# No route to the internet at all: the database and the cache talk to the
# tasks and to nothing else.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${local.name}-data" }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "data" {
  count = length(aws_subnet.data)

  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# S3 without leaving the VPC: document traffic never touches the NAT gateway,
# which is both cheaper and one less place it could be observed.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id, aws_route_table.data.id]

  tags = { Name = "${local.name}-s3" }
}

# ---------------------------------------------------------------------------
# Who may talk to whom
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "The load balancer, which is the only public thing here"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from wherever this environment is reachable"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  ingress {
    description = "HTTP, which is answered with a redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  egress {
    description = "To the tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "Every container: the API, the worker, the two apps, the scanner"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From the load balancer only"
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "Between tasks: the API reaching the scanner, and the metrics scrape"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }

  # Outbound is open because tasks pull images, reach Secrets Manager and, in
  # the worker's case, send a patient an SMS. What they cannot do is be reached.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-tasks" }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Postgres, reachable from the tasks and nothing else"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Postgres from the tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  tags = { Name = "${local.name}-database" }
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "Redis, reachable from the tasks and nothing else"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Redis from the tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  tags = { Name = "${local.name}-cache" }
}
