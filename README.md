# Discord Roblox Gift Bot

## 功能
- `/gift prize:<奖品> duration:<时长>` 创建活动
- 只有 Discord Community Owner 能创建、取消、结束、重抽
- 默认活动规则自动显示
- 用户点击按钮后必须填写 Roblox 用户名
- Bot 通过 Roblox 官方 Users API 验证用户名
- Discord 用户每个活动只能参加一次
- 同一个 Roblox 账号每个活动也只能参加一次
- 活动到期自动随机开奖
- 自动公开 @中奖者、Roblox 用户名和奖品
- 支持 `/giftstatus`、`/giftcancel`、`/gift-end`、`/gift-reroll`
- SQLite 持久化
- Render 可直接部署

## Render 环境变量
必须：
- `TOKEN`
- `CLIENT_ID`

可选：
- `CHANNEL_ID`：活动消息固定发送到这个频道\n- `GUILD_ID`：填写后命令会立即注册到指定服务器；适合测试
- `PORT`：Render 通常会自动提供
- `DB_PATH`：默认 `giveaways.db`

## 时长写法
- `10m` = 10分钟
- `2h` = 2小时
- `3d` = 3天

允许范围：1分钟～30天。

## Discord Bot 权限
邀请 Bot 时至少给：
- View Channels
- Send Messages
- Embed Links
- Read Message History
- Use Slash Commands

如果要在活动频道正常工作，请确保 Bot 有这些权限。

## Render
Build Command:
`npm install`

Start Command:
`npm start`

Node 18+。

注意：Render 免费/临时磁盘重启可能丢 SQLite 文件。若需要长期保存活动数据，建议使用 Render Persistent Disk 或外部 PostgreSQL。


活动频道 ID 已内置为 `1538392351926394963`，不需要在 Render 添加频道 ID 变量。
