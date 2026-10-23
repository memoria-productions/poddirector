#!/usr/bin/env bash
# Download the third-party runtimes PodDirector bundles for Windows (not kept in git).
#   ffmpeg (LGPL build, BtbN) · whisper.cpp v1.9.1 CLI · Whisper base.en model · Silero VAD model
# Set MODEL=small.en for better accuracy (466 MB) or tiny.en for speed (75 MB).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/vendor"; TMP="$(mktemp -d)"
MODEL="${MODEL:-base.en}"
WHISPER_VERSION="${WHISPER_VERSION:-v1.9.1}"
mkdir -p "$V/ffmpeg/win32-x64" "$V/whisper/win32-x64" "$V/whisper/models/vad"

echo "ffmpeg (win64, LGPL)..."
curl -fsSL -o "$TMP/ffmpeg.zip" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip
unzip -j -o -q "$TMP/ffmpeg.zip" '*/bin/ffmpeg.exe' '*/LICENSE.txt' -d "$V/ffmpeg/win32-x64"

echo "whisper.cpp $WHISPER_VERSION (win x64)..."
curl -fsSL -o "$TMP/whisper.zip" "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION/whisper-bin-x64.zip"
unzip -j -o -q "$TMP/whisper.zip" 'Release/whisper-cli.exe' 'Release/whisper.dll' 'Release/ggml*.dll' -d "$V/whisper/win32-x64"

echo "Whisper model ggml-$MODEL.bin..."
curl -fsSL -o "$V/whisper/models/ggml-$MODEL.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
echo "Silero VAD model..."
curl -fsSL -o "$V/whisper/models/vad/ggml-silero-v5.1.2.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

rm -rf "$TMP"
du -sh "$V"/*/*
