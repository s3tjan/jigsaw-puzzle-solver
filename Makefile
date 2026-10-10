.PHONY: all build-cv build-web build start serve test-cv test-web test clean

# Default: build cv-engine WASM and start web-app dev server
all: start

# Build Rust cv-engine to WASM and copy binary to web-app/public
build-cv:
	@echo "==> Building cv-engine WASM..."
	cd cv-engine && wasm-pack build --target web --out-dir ../web-app/src/pkg
	@echo "==> Copying WASM binary to web-app/public..."
	cp web-app/src/pkg/cv_engine_bg.wasm web-app/public/cv_engine_bg.wasm

# Run cv-engine tests
test-cv:
	@echo "==> Running cv-engine test suite..."
	cd cv-engine && cargo test

# Run Angular web-app unit tests (headless)
test-web: build-cv
	@echo "==> Running Angular test suite..."
	cd web-app && npm test -- --watch=false --browsers=ChromeHeadless

# Run all test suites
test: test-cv test-web

# Build production bundle for web-app
build-web: build-cv
	@echo "==> Building Angular web application..."
	cd web-app && npm run build

build: build-web

# Build cv-engine WASM and launch the Angular development server
start: build-cv
	@echo "==> Starting web-app development server..."
	cd web-app && npm start

serve: start

# Clean build artifacts
clean:
	@echo "==> Cleaning cv-engine..."
	cd cv-engine && cargo clean
	rm -rf cv-engine/pkg
	rm -rf web-app/src/pkg
	rm -rf web-app/dist
	rm -f web-app/public/cv_engine_bg.wasm
