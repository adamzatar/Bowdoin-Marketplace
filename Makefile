SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

# Variables
PKG_MANAGER ?= pnpm
DOCKER_COMPOSE := docker-compose
KUBECTL ?= kubectl
HELM ?= helm
NAMESPACE ?= bowdoin-marketplace
REGISTRY ?= ghcr.io/bowdoin-marketplace
APP_NAME ?= web
VERSION ?= $(shell git rev-parse --short HEAD)

# Default target
.DEFAULT_GOAL := help

## —— 🎯 Development —————————————————————————————————————————————————————————————
install: ## Install dependencies
	$(PKG_MANAGER) install

dev: ## Run local dev server
	$(PKG_MANAGER) dev --filter=apps/web

lint: ## Lint all projects
	$(PKG_MANAGER) lint

format: ## Format with Prettier
	$(PKG_MANAGER) format

typecheck: ## Run TypeScript typecheck across all packages
	$(PKG_MANAGER) run typecheck

## —— 🗄️ Database ——————————————————————————————————————————————————————————————
db-migrate: ## Run Prisma migrations
	./scripts/migrate.sh

db-seed: ## Seed database
	./scripts/seed.sh

db-backup: ## Backup database
	./scripts/backup-db.sh

db-restore: ## Restore database
	./scripts/restore-db.sh

db-verify-backup: ## Verify database backup integrity
	./scripts/verify-backup.sh

db-backfill-affiliation: ## Run backfill script for affiliation
	pnpm tsx packages/db/scripts/backfill-affiliation.mts

## —— 🐳 Docker ———————————————————————————————————————————————————————————————
docker-build: ## Build Docker image
	docker build -t $(REGISTRY)/$(APP_NAME):$(VERSION) -f apps/web/Dockerfile .

docker-push: docker-build ## Push Docker image
	docker push $(REGISTRY)/$(APP_NAME):$(VERSION)

docker-up: ## Start local stack
	$(DOCKER_COMPOSE) up -d

docker-down: ## Stop local stack
	$(DOCKER_COMPOSE) down

## —— ☸️ Kubernetes & Helm ————————————————————————————————————————————————————
k8s-namespace: ## Create namespace if missing
	$(KUBECTL) get ns $(NAMESPACE) || $(KUBECTL) create ns $(NAMESPACE)

helm-deploy: k8s-namespace ## Deploy app via Helm
	$(HELM) upgrade --install $(APP_NAME) infra/helm/charts/app \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/app/values.yaml \
		--wait

helm-deploy-minio:
	$(HELM) upgrade --install minio infra/helm/charts/minio \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/minio/values.yaml \
		--wait

helm-deploy-postgres:
	$(HELM) upgrade --install postgres infra/helm/charts/postgres \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/postgres/values.yaml \
		--wait

helm-deploy-redis:
	$(HELM) upgrade --install redis infra/helm/charts/redis \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/redis/values.yaml \
		--wait

helm-deploy-otel:
	$(HELM) upgrade --install otel-collector infra/helm/charts/otel-collector \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/otel-collector/values.yaml \
		--wait

helm-deploy-prometheus:
	$(HELM) upgrade --install prometheus infra/helm/charts/prometheus-stack \
		--namespace $(NAMESPACE) \
		--values infra/helm/charts/prometheus-stack/values.yaml \
		--wait

helm-uninstall: ## Uninstall app
	$(HELM) uninstall $(APP_NAME) -n $(NAMESPACE) || true

## —— 🔒 Secrets ——————————————————————————————————————————————————————————————
secrets-encrypt: ## Encrypt all secrets with SOPS
	sops -e -i infra/helm/secrets/*.yaml

secrets-decrypt: ## Decrypt all secrets with SOPS
	sops -d infra/helm/secrets/*.yaml

## —— 🧪 Testing ——————————————————————————————————————————————————————————————
test: ## Run all tests
	$(PKG_MANAGER) test

test-watch:
	$(PKG_MANAGER) test --watch

## —— 🚀 CI/CD ——————————————————————————————————————————————————————————————
ci: install lint typecheck test ## Run full CI pipeline

deploy: docker-push helm-deploy ## Build, push, and deploy

## —— 📚 Help ——————————————————————————————————————————————————————————————
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'