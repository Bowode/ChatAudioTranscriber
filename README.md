# ChatAudioTranscriber

面向 QQ / 微信导出记录的完全本地离线语音后处理器。项目由 [Bowode](https://github.com/Bowode) 发起和维护，处理已经导出的 JSON、HTML 与音频，在原文件旁生成包含转写的增强副本。

**普通用户：[从 Releases 下载 Windows x64 便携版](https://github.com/Bowode/ChatAudioTranscriber/releases/latest)。不要把 GitHub 自动生成的 Source code ZIP 当成免安装包。**

## 日常使用

1. 将便携 ZIP 完整解压到可写本地 NTFS 目录，支持中文和空格。
2. 双击 **启动语音转写.cmd**。无需安装 Node.js、FFmpeg、npm 或 SQLite。
3. 拖入包含配套 JSON、HTML 和原有媒体资源的完整导出文件夹，按 Enter。
4. 核对平台、文件和消息数量，按 Enter 确认。已有增强文件时输入 Y 才覆盖，其他输入取消。
5. 等待任务完成，在原目录打开 原名.enhanced.html 或使用 原名.enhanced.json。

原始导出和媒体只读。图片、视频、音频直接复用原有相对路径，不复制第二套资源。增强文件需要与原资源一起保留。首次确认后自动在程序自身 data 目录建库，work 保存中间文件与报告；这些个人数据不会出现在原始发行包中。

## 上游导出工具与关系

- **QQ：** [NapCat Framework / NapCatQQ](https://github.com/NapNeko/NapCatQQ) + [QQ Chat Exporter](https://github.com/shuakami/qq-chat-exporter)。已验证 QCE 0.1.0 的内嵌 chunk/index 导出格式，参考导出器 v6.3.2。
- **微信：** 实际验证来源是 [WeFlow CLI v5.0.1](https://github.com/334456777/WeFlow/tree/v5.0.1)，其导出 JSON schema 为 1.0.3；同时致谢 [WeFlow 原项目 / hicccc77](https://github.com/hicccc77/WeFlow)。应用版本和导出格式版本不是同一个概念。

本项目是独立后处理器，不是上述项目的官方发行版。无需修改它们，不捆绑它们的程序、账号配置、查看器模板或客户端数据库，不负责提取密钥、登录账号或恢复未导出的资源。完整来源、用途与许可证边界见 [UPSTREAM.md](UPSTREAM.md)。

## 功能与边界

- 根据文件头识别 PCM16 WAV 和 SILK，包括前置 0x02 的 SILK；统一为 16 kHz mono PCM16 WAV。
- sherpa-onnx + SenseVoiceSmall INT8 本地识别，模型按需初始化，多个语音共享一次加载。
- SQLite 保存原始音频、PCM 与识别配置相关缓存；配置和内容相同时复用成功结果。中断任务按已有机制恢复，失败任务不自动重试。
- 增强 JSON 与 HTML，保持消息身份与顺序、原查看器搜索和媒体引用。微信原始音频未定位时显示状态提示，不伪造音频节点或转写文字。
- 每个集合需要明确配对的原始 JSON 和 HTML；暂不支持直接拖单个文件，无语音集合跳过。
- Windows 10/11 x64 为发行目标；其他架构、网络盘、不支持硬链接的文件系统未验收。ASR 文本可能有误，应结合原音频使用。

## 隐私与反馈

识别全程本地，不调用云端 ASR，不自动下载聊天媒体。请只处理自己有权使用的导出。分享本项目请使用干净 Release ZIP，**不要重新压缩使用后的 data、work 或聊天目录**。Issue 只提供版本、操作步骤、错误码和脱敏结构示例；不要上传聊天正文、个人音频、缓存数据库、密钥或令牌。

## 从源码运行

需要 Node.js 24.21.0 与 npm；在本仓库运行 npm ci 后 npm test。源码仓库不包含 node_modules、Node.exe、FFmpeg.exe、模型权重、tokens 或个人数据；所以源码 ZIP 本身不是便携发行包。

准备与本版 Release 一致的 Node/FFmpeg/模型资源，按 launcher.config.json 中的相对位置放置，再执行 npm start。模型仅使用 [Sherpa 官方 SenseVoiceSmall INT8 发行包](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2)；保留 LICENSE、来源与完整模型协议。FFmpeg 对应源码与构建脚本在便携 Release 的 runtime/ffmpeg/source 中，脚本也见 scripts/build-ffmpeg.sh。

当前可公开运行的单元测试只使用合成数据，不依赖个人聊天样本，不执行真实 ASR。历史个人样本测试及验收报告不随仓库发布；结构验证不代替用户本机浏览器播放验收。

## 许可证

**组合应用：GPL-3.0-only；原创部分额外提供 MIT 授权。** qce-bloom.mjs 的 QCE 来源部分保留 GPL，不能把整个发行包称为纯 MIT。详见 [LICENSE](LICENSE)、[LICENSE-MIT](LICENSE-MIT)、[LICENSE_SCOPE.md](LICENSE_SCOPE.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。推理引擎、模型和其他依赖各自遵循原许可，本项目许可不改变它们的权利与限制。
