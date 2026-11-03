# Application license scope

The combined ChatAudioTranscriber application is distributed under GPL-3.0-only (LICENSE). The original contributions identified in LICENSE_SCOPE.md are additionally available under MIT (LICENSE-MIT). No third-party component is relicensed by those grants.

The application includes a QCE-compatible Bloom implementation adapted with reference to QQ Chat Exporter v6.3.2 (GPL-3.0); see UPSTREAM.md for source-file links and attribution. WeFlow, NapCat Framework and QQ Chat Exporter executables, account configuration and viewer templates are not bundled.

# Third-party components

This package is a local offline Windows x64 application. Each component retains its own license. No new license is assigned to third-party code.

| Component | Version / source | License / notice |
|---|---|---|
| Node.js | 24.21.0 Windows x64; https://nodejs.org/dist/v24.21.0/ | MIT and bundled dependency notices; licenses/node/LICENSE |
| parse5 | 8.0.0; https://github.com/inikulin/parse5 | MIT; node_modules/parse5/LICENSE |
| entities | 6.0.1; https://github.com/fb55/entities | BSD-2-Clause; node_modules/entities/LICENSE |
| silk-wasm | 3.7.1; https://github.com/idranme/silk-wasm | MIT; node_modules/silk-wasm/LICENSE |
| SILK SDK | sources used by silk-wasm; https://github.com/idranme/silk-wasm/tree/v3.7.1/binding/libSilkCodec/silk | licenses/silk/SILK-SDK-LICENSE (BSD terms retained) |
| sherpa-onnx Node + Windows x64 native | npm 2.0.1; native git af2d8d81; https://github.com/k2-fsa/sherpa-onnx | Apache-2.0; licenses/sherpa-onnx/LICENSE |
| ONNX Runtime | 1.28.2, bundled by sherpa-onnx; https://github.com/microsoft/onnxruntime/tree/v1.28.2 | MIT; licenses/onnxruntime/LICENSE and ThirdPartyNotices.txt |
| SenseVoiceSmall INT8 | Alibaba / FunAudioLLM SenseVoice, ONNX conversion distributed by k2-fsa/sherpa-onnx; release 2024-07-17 | models/sensevoice/LICENSE refers to FunASR model agreement; full agreement in licenses/sensevoice/FunASR-MODEL_LICENSE |
| FFmpeg | 9.0.2 minimal static Windows build from official source; https://ffmpeg.org/ | LGPLv2.1+; runtime/ffmpeg/LICENSE, bundled full corresponding FFmpeg source and build script in runtime/ffmpeg/source; compiler runtime notices in licenses/ffmpeg |

SenseVoice model name, author attribution, and official model origin are retained in models/sensevoice/README.md and SOURCE.json. The model agreement permits sharing subject to its conditions and attribution requirements; it is not the Apache license of the inference engine.

The bundled FFmpeg executable is deliberately limited to this application's PCM16 WAV / raw PCM conversion and resampling. SILK decoding remains in the unchanged silk-wasm pipeline. It is not a general-purpose video conversion distribution. The original source of FFmpeg is included so recipients may rebuild and replace the executable; redistribution must preserve the applicable licenses and corresponding-source obligations.

Node.js executable has been matched against the official release SHASUMS256.txt; the complete Node.js third-party license file is included. This is a checksum comparison, not a fresh PGP signature verification. Production npm packages and native DLLs were copied at their locked versions without rebuilding or modifying them.
