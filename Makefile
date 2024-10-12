# Default target: Build the site
HUGO := hugo
BUILD_DIR := public

.PHONY: all
all: build

.PHONY: serve
serve:
	CF_PAGES_COMMIT_SHA=$$(git rev-parse --short HEAD) $(HUGO) server -D -F --buildDrafts --buildFuture

new:
	@if [ -z "$(name)" ]; then \
		echo "Error: You must provide a filename. Usage: make new name=<filename>"; \
		exit 1; \
	fi
	CF_PAGES_COMMIT_SHA=$$(git rev-parse --short HEAD) $(HUGO) new content "posts/$(name)"
	
