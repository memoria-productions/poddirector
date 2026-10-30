# Third-party notices

PodCutter bundles or adapts the following works.

## FFmpeg (bundled binary: vendor/ffmpeg/…/ffmpeg.exe)
Licensed under the GNU Lesser General Public License v2.1 or later (LGPL build from https://github.com/BtbN/FFmpeg-Builds).
See vendor/ffmpeg/win32-x64/LICENSE.txt. Source code: https://ffmpeg.org/download.html and https://github.com/BtbN/FFmpeg-Builds.
PodCutter runs ffmpeg as a separate program and does not link to it; you may replace the binary with your own build (Settings > Custom ffmpeg path).

## whisper.cpp (bundled binaries: vendor/whisper/…)
MIT License, Copyright (c) 2023-2026 The ggml authors. https://github.com/ggml-org/whisper.cpp

## OpenAI Whisper model weights (vendor/whisper/models/ggml-*.bin, converted by whisper.cpp)
MIT License, Copyright (c) 2022 OpenAI. https://github.com/openai/whisper

## Silero VAD (vendor/whisper/models/vad/ggml-silero-v5.1.2.bin)
MIT License, Copyright (c) 2020-present Silero Team. https://github.com/snakers4/silero-vad

## Podclip (ideas and approach adapted: sequence reading, duplicate-then-razor workflow, camera "shows" tagging)
MIT License, Copyright (c) 2026 Podclip contributors. https://github.com/treydoe1/podclip-public-release

## Cutcast (ideas adapted: per-mic calibration against the loudest mic, cutaway placement at quiet points, shortest-first minimum-shot merging)
MIT License, Copyright (c) 2026 BoazCohenJ. https://github.com/BoazCohenJ/Cutcast

## MIT License text (applies to the MIT-licensed items above)
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
