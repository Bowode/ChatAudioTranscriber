# 上游项目与致谢

ChatAudioTranscriber 是由 [Bowode](https://github.com/Bowode) 发起和维护的独立语音后处理项目。本项目实现对已有导出的扫描、音频标准化、本地转写、缓存与增强副本生成；不主张对聊天导出、语音识别或其上游项目的首创权，也不是以下项目的官方发行版或官方合作项目。

| 项目 | 在工作流中的作用 | 来源与许可边界 |
|---|---|---|
| [NapCat Framework / NapCatQQ](https://github.com/NapNeko/NapCatQQ) | QQ 导出链路的前置框架 | 仅作外部前置工具链接；不随本项目分发。其 [许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE) 独立适用 |
| [QQ Chat Exporter](https://github.com/shuakami/qq-chat-exporter) | QQ JSON、HTML 与媒体导出 | 本项目已验证 QCE 0.1.0 导出格式；参考工具版本 [v6.3.2](https://github.com/shuakami/qq-chat-exporter/tree/v6.3.2)，[GPL-3.0](https://github.com/shuakami/qq-chat-exporter/blob/v6.3.2/LICENSE)。程序本体不捆绑 |
| [WeFlow CLI](https://github.com/334456777/WeFlow) | 微信 JSON、HTML 与媒体导出 | 实际验证来源为 [v5.0.1](https://github.com/334456777/WeFlow/tree/v5.0.1)，导出 JSON schema 为 1.0.3；程序本体不捆绑，[原许可](https://github.com/334456777/WeFlow/blob/v5.0.1/LICENSE) 不改写 |
| [WeFlow 原项目](https://github.com/hicccc77/WeFlow) | WeFlow 项目来源 | 按 WeFlow CLI README 的作者说明，保留 hicccc77 的项目归属；下载与当前功能以各自仓库为准 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地推理引擎和 ONNX 模型发行来源 | Apache-2.0 引擎；模型独立许可 |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | 本地语音识别模型 | Alibaba / FunAudioLLM；原模型与 ONNX 发行来源见 models/sensevoice/SOURCE.json；保留模型协议 |
| [silk-wasm](https://github.com/idranme/silk-wasm) | SILK 解码 | 保留 MIT 与所含 SILK SDK 许可 |
| [FFmpeg](https://ffmpeg.org/) | PCM 音频重采样 | 随包精简构建为 LGPLv2.1+，对应源码、构建脚本与许可随 Release 提供 |

## QCE 来源部分

qce-bloom.mjs 顶部已标注对应关系。算法参数、UTF-16 字符单元、大小写、n-gram 与位序必须匹配原查看器，不能为了改变许可证随意改写格式行为。保留以下来源与贡献者归属：

- [QCE v6.3.2 viewer bloom.ts](https://github.com/shuakami/qq-chat-exporter/blob/v6.3.2/qce-chunked-viewer/src/qce/bloom.ts)
- [QCE v6.3.2 core bloom.rs](https://github.com/shuakami/qq-chat-exporter/blob/v6.3.2/qq-chat-export-core/src/bloom.rs)
- 归属：shuakami 与 QQ Chat Exporter contributors；本项目提供兼容实现适配与整合。

仅提供上游链接和格式兼容，不意味着本项目拥有、维护或代表上游。若未来复制或修改其他上游代码，应先核对该版本的许可证与来源，而不是仅添加一个致谢链接。
