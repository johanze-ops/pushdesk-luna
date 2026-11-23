#!/bin/bash
# Build the helper and the stand-alone screen program as universal binaries (Apple Silicon +
# Intel), macOS 12 or later, into helper/build/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/tmp
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos12" -o "build/tmp/pushdesk-luna-helper-$arch" Sources/Screen.swift Sources/helper/main.swift
  xcrun swiftc -O -target "$arch-apple-macos12" -o "build/tmp/push2screen-$arch" Sources/Screen.swift Sources/push2screen/main.swift
done
lipo -create -output build/pushdesk-luna-helper build/tmp/pushdesk-luna-helper-arm64 build/tmp/pushdesk-luna-helper-x86_64
lipo -create -output build/push2screen build/tmp/push2screen-arm64 build/tmp/push2screen-x86_64
codesign --force -s - build/pushdesk-luna-helper build/push2screen
rm -rf build/tmp
lipo -info build/pushdesk-luna-helper build/push2screen
