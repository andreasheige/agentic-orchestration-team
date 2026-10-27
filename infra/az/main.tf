# Azure Container Apps deployment — lightweight Option B
# Uses GHCR for images, OIDC for auth, single region (swedencentral)
# All resources live in one pre-created resource group for easy cost tracking.

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.10"
    }
  }
  backend "azurerm" {
    # Populated per-env via CI terraform init step
    # All resources (incl. TF state SA) live in the same RG
  }
}

provider "azurerm" {
  features {}
  # OIDC via federated identity — no client_secret needed
  use_oidc = true
}

# ─── Variables ─────────────────────────────────────────────────────────────────

variable "env" {
  type        = string
  description = "Deployment environment (npr, prd)"
}

variable "resource_group_name" {
  type        = string
  description = "Pre-created resource group (single RG for all resources)"
}

variable "location" {
  type    = string
  default = "swedencentral"
}

variable "image_tag" {
  type        = string
  description = "GHCR image tag (SHA or SHA-version)"
}

variable "azure_openai_endpoint" {
  type = string
}

variable "azure_openai_deployment" {
  type    = string
  default = "gpt-4o"
}

variable "azure_openai_account_name" {
  type        = string
  description = "Name of the pre-created Azure OpenAI resource"
}

locals {
  product   = "agent-team"
  prefix    = "agnt0001" # TODO: replace with allocated terraform prefix
  image_api = "ghcr.io/${github.repository_owner}/${local.product}:${var.image_tag}"
}

# ─── Data ──────────────────────────────────────────────────────────────────────

data "azurerm_client_config" "current" {}

# ─── Resource Group (pre-created, referenced as data) ─────────────────────────

data "azurerm_resource_group" "main" {
  name = var.resource_group_name
}

# ─── Key Vault ─────────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "kv" {
  name                       = "kv-${local.prefix}-${var.env}"
  location                   = data.azurerm_resource_group.main.location
  resource_group_name        = data.azurerm_resource_group.main.name
  sku_name                   = "standard"
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  enable_rbac_authorization  = true
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
}

# ─── Redis ─────────────────────────────────────────────────────────────────────

resource "azurerm_redis_cache" "redis" {
  name                = "${local.prefix}-redis-${var.env}"
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  capacity            = var.env == "prd" ? 2 : 1
  family              = "C"
  sku_name            = "Standard"
  enable_non_ssl_port = false
  minimum_tls_version = "1.2"
}

# ─── Log Analytics (Container Apps requirement) ───────────────────────────────

resource "azurerm_log_analytics_workspace" "logs" {
  name                = "law-${local.prefix}-${var.env}"
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# ─── Container Apps Environment ───────────────────────────────────────────────

resource "azurerm_container_app_environment" "env" {
  name                       = "cae-${local.prefix}-${var.env}"
  location                   = data.azurerm_resource_group.main.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id
}

# ─── API (NestJS) — public ingress, 1–3 replicas ─────────────────────────────

resource "azurerm_container_app" "api" {
  name                         = "ca-${local.prefix}-api-${var.env}"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = data.azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type = "SystemAssigned"
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  registry {
    server   = "ghcr.io"
    username = "<your-org>"
    password_secret_name = "ghcr-token"
  }

  secret {
    name  = "ghcr-token"
    value = "placeholder" # Managed by CI — replaced at deploy time
  }

  secret {
    name  = "redis-password"
    value = azurerm_redis_cache.redis.primary_access_key
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "api"
      image  = local.image_api
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "REDIS_URL"
        value = "rediss://:${azurerm_redis_cache.redis.primary_access_key}@${azurerm_redis_cache.redis.hostname}:6380"
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
  }
}

# ─── Worker (Orchestrator) — internal only, 0–10 scale-to-zero ───────────────

resource "azurerm_container_app" "worker" {
  name                         = "ca-${local.prefix}-worker-${var.env}"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = data.azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type = "SystemAssigned"
  }

  registry {
    server   = "ghcr.io"
    username = "<your-org>"
    password_secret_name = "ghcr-token"
  }

  secret {
    name  = "ghcr-token"
    value = "placeholder"
  }

  secret {
    name  = "redis-password"
    value = azurerm_redis_cache.redis.primary_access_key
  }

  template {
    min_replicas = 0
    max_replicas = 10

    container {
      name   = "worker"
      image  = local.image_api
      cpu    = 1.0
      memory = "2Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "REDIS_URL"
        value = "rediss://:${azurerm_redis_cache.redis.primary_access_key}@${azurerm_redis_cache.redis.hostname}:6380"
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

    custom_scale_rule {
      name             = "queue-scale"
      custom_rule_type = "redis"
      metadata = {
        listName   = "bull:agent-jobs:wait"
        listLength = "1"
        address    = "rediss://${azurerm_redis_cache.redis.hostname}:6380"
      }
      authentication {
        secret_ref        = "redis-password"
        trigger_parameter = "password"
      }
    }
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

# ─── OpenAI RBAC (managed identity — no API key needed) ───────────────────────

data "azurerm_cognitive_account" "openai" {
  name                = var.azure_openai_account_name
  resource_group_name = data.azurerm_resource_group.main.name
}

resource "azurerm_role_assignment" "api_openai" {
  scope                = data.azurerm_cognitive_account.openai.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_container_app.api.identity[0].principal_id
}

resource "azurerm_role_assignment" "worker_openai" {
  scope                = data.azurerm_cognitive_account.openai.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_container_app.worker.identity[0].principal_id
}

# ─── Outputs u2500─────────────────────────────────────────────────────────────────────

output "api_url" {
  value = "https://${azurerm_container_app.api.ingress[0].fqdn}"
}

output "resource_group" {
  value = data.azurerm_resource_group.main.name
}

output "key_vault_name" {
  value = azurerm_key_vault.kv.name
}
