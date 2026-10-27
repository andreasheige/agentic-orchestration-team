# Deploys the full agent platform to Azure Container Apps
# Run: terraform init && terraform apply

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.10"
    }
  }
  # Store state in Azure Blob — replace with your values
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "mytfstate"
    container_name       = "tfstate"
    key                  = "agent-platform.tfstate"
  }
}

provider "azurerm" {
  features {}
}

variable "env" { default = "prod" }
variable "location" { default = "swedencentral" } # closest to Gothenburg
variable "azure_openai_api_key" { sensitive = true }
variable "azure_openai_endpoint" { type = string }
variable "azure_openai_deployment" { default = "gpt-4o" }

# ─── Resource group ────────────────────────────────────────────────────────────
resource "azurerm_resource_group" "main" {
  name     = "rg-agent-platform-${var.env}"
  location = var.location
}

# ─── Container Registry ────────────────────────────────────────────────────────
resource "azurerm_container_registry" "acr" {
  name                = "agentplatformacr"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = false
}

# ─── Key Vault — stores secrets, not env vars ──────────────────────────────────
resource "azurerm_key_vault" "kv" {
  name                = "kv-agent-${var.env}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "standard"
  tenant_id           = data.azurerm_client_config.current.tenant_id
}

resource "azurerm_key_vault_secret" "openai_key" {
  name         = "azure-openai-api-key"
  value        = var.azure_openai_api_key
  key_vault_id = azurerm_key_vault.kv.id
}

# ─── Redis (session state + BullMQ queue) ─────────────────────────────────────
resource "azurerm_redis_cache" "redis" {
  name                = "agent-redis-${var.env}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 1         # 1GB — bump if session state grows
  family              = "C"
  sku_name            = "Standard" # Standard = replicated, production-safe
  enable_non_ssl_port = false
  minimum_tls_version = "1.2"
}

# ─── Container Apps Environment ───────────────────────────────────────────────
resource "azurerm_container_app_environment" "env" {
  name                = "cae-agent-${var.env}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
}

# ─── API Gateway (NestJS) — public, scales 1–3 ───────────────────────────────
resource "azurerm_container_app" "api" {
  name                         = "ca-api-gateway"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  ingress {
    external_enabled = true
    target_port      = 3000
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "api"
      image  = "${azurerm_container_registry.acr.login_server}/agent-api:latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "REDIS_URL"
        value = "rediss://:${azurerm_redis_cache.redis.primary_access_key}@${azurerm_redis_cache.redis.hostname}:6380"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
    }

    # Scale on concurrent HTTP requests — one replica handles ~50 requests
    custom_scale_rule {
      name             = "http-scale"
      custom_rule_type = "http"
      metadata = {
        concurrentRequests = "50"
      }
    }
  }
}

# ─── Worker Pool (Orchestrator) — internal, scales 1–10 ──────────────────────
# Each replica picks up one job at a time from BullMQ
# 10 teams = max 10 workers running concurrently
resource "azurerm_container_app" "worker" {
  name                         = "ca-agent-worker"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  # No ingress — workers are internal only, pull from Redis queue
  template {
    min_replicas = 0  # scale to zero when no jobs
    max_replicas = 10 # one per team

    container {
      name   = "worker"
      image  = "${azurerm_container_registry.acr.login_server}/agent-worker:latest"
      cpu    = 1.0    # agents do CPU-light I/O work, but need headroom
      memory = "2Gi"

      env {
        name  = "REDIS_URL"
        value = "rediss://:${azurerm_redis_cache.redis.primary_access_key}@${azurerm_redis_cache.redis.hostname}:6380"
      }
      env {
        name        = "AZURE_OPENAI_API_KEY"
        secret_name = "azure-openai-api-key" # pulled from Key Vault
      }
      env {
        name  = "AZURE_OPENAI_ENDPOINT"
        value = var.azure_openai_endpoint
      }
      env {
        name  = "AZURE_OPENAI_DEPLOYMENT"
        value = var.azure_openai_deployment
      }
    }

    # Scale on BullMQ queue depth — spin up a worker per pending job
    custom_scale_rule {
      name             = "queue-scale"
      custom_rule_type = "redis"
      metadata = {
        listName  = "bull:agent-jobs:wait"
        listLength = "1" # 1 job → 1 new worker replica
        address   = "rediss://${azurerm_redis_cache.redis.hostname}:6380"
      }
      authentication {
        secret_ref        = "redis-password"
        trigger_parameter = "password"
      }
    }
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "api_url" {
  value = "https://${azurerm_container_app.api.ingress[0].fqdn}"
}
output "redis_host" {
  value     = azurerm_redis_cache.redis.hostname
  sensitive = true
}

data "azurerm_client_config" "current" {}
