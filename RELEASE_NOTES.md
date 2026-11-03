# v1.0.1 — Windows x64 Portable Edition

面向已经导出的 QQ / 微信聊天记录，提供完全本地的语音转写与同目录 JSON/HTML 增强。

## 下载与使用

下载 ChatAudioTranscriber-Portable-v1.0.1-windows-x64.zip，完整解压后双击 启动语音转写.cmd，拖入导出目录并确认。附带 SHA256SUMS.txt。GitHub 自动附带的 Source code ZIP 不包含运行环境和模型。

## 包含

- Node.js 24.21.0 Windows x64、生产依赖、SenseVoiceSmall INT8、FFmpeg 9.0.2 精简静态构建及所需第三方许可证。
- 已验收的 WeFlow 未定位语音状态提示修复。
- 每位用户首次确认后创建自己的本地缓存，不包含任何已有个人数据库、音频或聊天记录。

## 兼容与归属

QQ：NapCat Framework + QQ Chat Exporter（QCE 0.1.0 导出格式）。微信：WeFlow CLI v5.0.1 的 schema 1.0.3 导出。不是这些项目的官方发行版；来源链接与许可证见 README 和 UPSTREAM.md。

组合应用遵循 GPL-3.0-only，原创部分另附 MIT；随包模型及运行库遵循各自许可证。FFmpeg 的对应源码、构建脚本及 LGPL 说明随包提供。

目标为 Windows 10/11 x64、本地 NTFS 可写目录。缺失音频只显示状态，不生成虚构识别结果。请勿在 Issue 上传个人聊天记录、音频、数据库或访问令牌。
