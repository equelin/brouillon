MISE    ?= mise exec --
NPM     ?= $(MISE) npm
NODE    ?= $(MISE) node
BINDIR  ?= $(HOME)/.local/bin

.DEFAULT_GOAL := help

.PHONY: help
help: ## List targets
	@sed -n 's/^\([a-z-]*\):.*## \(.*\)/  \1|\2/p' $(MAKEFILE_LIST) | column -t -s'|'

.PHONY: setup
setup: ## Trust and install tools, then dependencies
	mise trust
	mise install
	$(NPM) ci --ignore-scripts

.PHONY: fmt
fmt: ## Rewrite sources to the formatter's output
	$(MISE) npx biome format --write

.PHONY: lint
lint: ## Run the linter and the type checker
	$(MISE) npx biome check
	$(MISE) npx tsc

.PHONY: test
test: ## Run the unit tests
	$(NODE) --test "tests/*.test.ts"

.PHONY: check
check: ## Lint, then test
	$(MAKE) lint
	$(MAKE) test

.PHONY: install
install: ## Install the brouillon launcher into BINDIR
	mkdir -p $(BINDIR)
	printf '#!/bin/sh\nexec "%s" "%s/src/main.ts" "$$@"\n' "$$(mise which node)" "$(CURDIR)" > $(BINDIR)/brouillon
	chmod +x $(BINDIR)/brouillon

# --- brouillon-specific

.PHONY: run
run: ## Start brouillon from this checkout
	$(NODE) src/main.ts
