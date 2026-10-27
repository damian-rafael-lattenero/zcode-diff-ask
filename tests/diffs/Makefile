# Build targets for the diff-ask fixture suite.

FILES := $(wildcard tests/diffs/*)

.PHONY: list count clean

list:
	@echo "fixture files:"
	@$(foreach f,$(FILES),echo "  - $(f)";)

count:
	@wc -l $(FILES) | tail -1

clean:
	@echo "nothing to clean"
