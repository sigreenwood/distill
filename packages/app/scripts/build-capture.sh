#!/bin/sh
# Compiles the Swift audio-capture helper to native/capture/build/distill-capture.
# Apple Silicon, macOS 14.2+ (Core Audio process taps).
set -eu
cd "$(dirname "$0")/../native/capture"
mkdir -p build
swiftc -O -swift-version 5 -target arm64-apple-macos14.2 main.swift -o build/distill-capture
echo "built $(pwd)/build/distill-capture"
