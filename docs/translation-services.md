# 字幕与配音翻译服务

打开「设置 → 常规 → 字幕与配音翻译服务」。此设置用于新建的内置字幕、配音工作流，以及尚未开始处理的自动发布任务。已经运行的工作流保留原服务。分区、标签和投稿文案继续使用已配置的大模型。

| 服务 | 凭据与用法 |
| --- | --- |
| Google 网页翻译 | 沿用本地参考扩展的 Google GTX 接口。无需密钥，无服务可用性承诺；遇到拒绝或限流可改用本机服务。 |
| Google Cloud Translation | 官方 Cloud Translation Basic (v2)，需要 API 密钥；有月度免费额度，超额可能计费。 |
| Microsoft Azure Translator | 使用 Translator v3；需要 Azure 密钥，区域资源还需填区域代码。要使用免费额度，请创建 F0 资源。 |
| LibreTranslate | 本机免密钥，字幕文本不出本机。命令见下方。 |
| B 站 | 未找到公开的通用文本翻译接口，因此不参与任务处理。 |

本机 LibreTranslate 已配置为监听 `127.0.0.1:5000`。需要重新启动时，在项目根目录运行：

```powershell
./scripts/start-local-translation.ps1
```

脚本使用独立的 Python 环境。可传 `-Port 5001` 修改监听端口，同时在应用里填写同一个端口。云服务的代理端口另行设置，`0` 为直连。
