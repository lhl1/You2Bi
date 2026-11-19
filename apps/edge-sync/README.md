# You2Bi：同步 Edge 的 YouTube 登录

Windows 本机仅需设置一次。先运行项目中的 `scripts/install-edge-youtube-sync.ps1` 注册本机同步程序。然后在已登录 YouTube 的 Edge 配置中打开 `edge://extensions`，开启「开发人员模式」，点「加载解压缩的扩展」，选择本目录。首次点击「You2Bi · YouTube 登录同步」启用，显示 `OK` 表示已同步。

以后 Edge 在此配置中启动时、YouTube Cookie 更新时以及每 5 分钟自动检查。有变更时通过 Edge 原生消息发送给同一台电脑的 You2Bi。同步不需要关闭 Edge，不需要制作或保存 Cookie 文件，也不读取其他站点的 Cookie。

请使用带自动恢复功能的 You2Bi 版本。凭据变更后，程序会自动恢复仍在等待 YouTube 登录的原任务；手动暂停的任务、已经投稿的任务不受影响。Edge 完全关闭时，You2Bi 仍可使用最后一次同步成功的凭据。若 Google 要求重新登录，只需在同一 Edge 配置登录，扩展会自动同步。

再次点击扩展可以暂停同步。如需清除应用已保存的凭据，请先暂停扩展，再在 You2Bi「自动发布 → 账号与设置 → YouTube 登录凭据」清除。
