# 首次发布到 GitHub

目标：`Bowode/ChatAudioTranscriber`。这里的文件和 Release 素材已在本地准备；完成网页发布前，不应把文档中的目标地址描述成已经发布。

## 1. 创建源码仓库

在自己已经登录的 GitHub 中打开 https://github.com/new 。

- Owner：Bowode。
- Repository name：ChatAudioTranscriber。
- Description：Local offline voice transcription post-processor for QQ/QCE and WeFlow exports。
- 若准备公开发布，选择 Public。
- 不勾选自动添加 README、.gitignore 或许可证模板，使用本项目已准备的版本。
- 创建仓库。

项目根 LICENSE 是 GPL-3.0，LICENSE-MIT 是原创部分的额外授权。不要在建仓时另选 MIT 模板覆盖 LICENSE。第三方组件继续使用各自许可。

## 2. 上传源码

已经配置 GitHub Git 登录时，可从本地 Git 仓库推送 main 和 v1.0.1 标签。没有 Git 登录环境时，也可以在空仓库页面选择 uploading an existing file / Upload files：

1. 解压本次提供的 Source ZIP，进入内部的 ChatAudioTranscriber 文件夹。
2. 上传内部的源码、文档、test、licenses、models 元数据、scripts 及隐藏的 .gitignore、.gitattributes，保留相对目录结构。
3. 不上传 .git、node_modules、data、work、runtime 或便携 ZIP 到 Code。
4. 提交说明可使用 `Release v1.0.1 portable source`。

GitHub Code 中应直接看到 README.md、LICENSE、package.json 等，而不是把整个源码 ZIP 作为唯一文件，也不是多套一层 ChatAudioTranscriber 目录。网页创建的提交与本地 Git 提交不是同一历史；以后改用 Git 维护应先 clone 网页仓库，不要对它 force push。

## 3. 创建便携 Release

仓库创建并上传源码后，进入 Releases → Draft a new release：

- Tag：v1.0.1，基于 main 创建；若已由 Git 推送同名标签，则选现有标签。
- Release title：ChatAudioTranscriber v1.0.1 — Windows x64 Portable Edition。
- 正文复制 RELEASE_NOTES.md 的内容。
- 上传 ChatAudioTranscriber-Portable-v1.0.1-windows-x64.zip 和 SHA256SUMS.txt。
- 检查附件完整后发布正式 Release。

便携包约 204 MiB，放在 Release 附件中；不要放进普通 Git 历史。GitHub 自动附带的 Source code ZIP 不包含模型和运行环境，不能替代便携包。

## 4. 上游项目链接

README 和 UPSTREAM.md 已分别链接：

- NapCat Framework / NapCatQQ：https://github.com/NapNeko/NapCatQQ
- QQ Chat Exporter：https://github.com/shuakami/qq-chat-exporter
- 实际验证的 WeFlow CLI v5.0.1：https://github.com/334456777/WeFlow/tree/v5.0.1
- WeFlow 原项目与作者归属：https://github.com/hicccc77/WeFlow

这些是前置工具、格式来源或代码来源的说明，不代表官方合作或背书。QCE Bloom 的代码来源与 GPL 义务已单独保留；仅加链接不能替代许可证要求。不需要也不应自动向上游开 Issue、发评论或发送宣传消息。

## 5. 分享范围

只上传本次干净发布素材。不要从已经处理个人聊天的安装目录重新压缩，不要上传运行报告、个人音频、聊天 HTML/JSON、数据库、密钥或令牌。公开问题反馈只使用合成或脱敏结构示例。
