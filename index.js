const express = require("express");
const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events
} = require("discord.js");

const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error("Missing TOKEN environment variable.");

const PORT = Number(process.env.PORT || 3000);
const CHANNEL_ID = "1538392351926394963";
const db = new Database(process.env.DB_PATH || "giveaways.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_discord_id TEXT,
  winner_roblox_username TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  discord_tag TEXT,
  roblox_user_id TEXT NOT NULL,
  roblox_username TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  UNIQUE(giveaway_id, discord_id),
  UNIQUE(giveaway_id, roblox_user_id)
);
`);

const DEFAULT_RULES = [
  "每个 Discord 用户只能参与一次。",
  "参与活动必须填写有效的 Roblox 用户名。",
  "严禁使用多个 Discord 账号重复参与。",
  "活动结束后由 Bot 随机抽取中奖者。",
  "中奖结果由 Bot 自动公开公布。",
  "中奖后请在 24 小时内联系社区 Owner 兑换奖品。",
  "超过 24 小时未联系 Owner，视为放弃领奖，Owner 可以重新抽奖。",
  "如发现作弊、重复参与或恶意刷活动，Owner 有权取消其参与资格。",
  "活动奖品以活动页面显示的内容为准。",
  "本活动最终解释权归社区 Owner 所有。"
];

function parseDuration(input) {
  const m = String(input).trim().match(/^(\\d+(?:\\.\\d+)?)\\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  let ms;
  if (unit.startsWith("m")) ms = n * 60 * 1000;
  else if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
  else ms = n * 24 * 60 * 60 * 1000;
  if (ms < 60 * 1000 || ms > 30 * 24 * 60 * 60 * 1000) return null;
  return Math.floor(ms);
}

function formatRemaining(ms) {
  if (ms <= 0) return "已结束";
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分钟`);
  if (!parts.length) parts.push(`${s}秒`);
  return parts.slice(0, 3).join(" ");
}

async function resolveRobloxUsername(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    })
  });
  if (!r.ok) throw new Error("Roblox API error");
  const data = await r.json();
  const user = data.data?.[0];
  if (!user) return null;
  return { id: String(user.id), name: user.name, displayName: user.displayName };
}

function participantsCount(gid) {
  return db.prepare("SELECT COUNT(*) c FROM entries WHERE giveaway_id=?").get(gid).c;
}

function activeGiveaway(guildId) {
  return db.prepare("SELECT * FROM giveaways WHERE guild_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(guildId);
}

function giveawayEmbed(g) {
  const count = participantsCount(g.id);
  const remaining = formatRemaining(g.end_at - Date.now());
  const rules = DEFAULT_RULES.map((x, i) => `${i + 1}. ${x}`).join("\\n");

  return new EmbedBuilder()
    .setTitle("🎁 免费参与活动")
    .setDescription(
      `## 奖品\\n**${g.prize}**\\n\\n` +
      `⏰ **活动截止**\\n<t:${Math.floor(g.end_at / 1000)}:F>\\n` +
      `⏳ **剩余时间**\\n${remaining}\\n\\n` +
      `👥 **参与人数：${count}**\\n\\n` +
      `### 📋 活动规则\\n${rules}\\n\\n` +
      `🏆 中奖后请在 **24小时内联系社区 Owner** 兑换奖品。`
    )
    .setFooter({ text: `活动 ID #${g.id}` })
    .setTimestamp(new Date(g.created_at));
}

function giveawayButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gift_join:${id}`).setLabel("🎉 参与活动").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gift_users:${id}`).setLabel("👥 查看参与者").setStyle(ButtonStyle.Secondary)
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("gift")
    .setDescription("创建免费抽奖活动（仅社区 Owner）")
    .addStringOption(o => o.setName("prize").setDescription("奖品内容").setRequired(true).setMaxLength(1000))
    .addStringOption(o => o.setName("duration").setDescription("活动时长，例如 10m、2h、3d").setRequired(true)),
  new SlashCommandBuilder().setName("giftstatus").setDescription("查看当前活动状态（仅社区 Owner）"),
  new SlashCommandBuilder().setName("giftcancel").setDescription("取消当前活动（仅社区 Owner）"),
  new SlashCommandBuilder().setName("gift-end").setDescription("立即结束并开奖（仅社区 Owner）"),
  new SlashCommandBuilder().setName("gift-reroll").setDescription("重新抽取中奖者（仅社区 Owner）")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (process.env.GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  }
}

async function ownerOnly(interaction) {
  if (!interaction.guild || interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({ content: "❌ 只有 Discord 社区 Owner 可以使用这个功能。", ephemeral: true });
    return false;
  }
  return true;
}

async function announceWinner(g, reroll = false) {
  const guild = await client.guilds.fetch(g.guild_id);
  const channel = await guild.channels.fetch(g.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const entries = db.prepare("SELECT * FROM entries WHERE giveaway_id=?").all(g.id);
  if (!entries.length) {
    db.prepare("UPDATE giveaways SET status='ended' WHERE id=?").run(g.id);
    await channel.send(`🎁 **活动结束**\\n\\n奖品：**${g.prize}**\\n\\n❌ 本次活动没有有效参与者，因此没有中奖者。`);
    return null;
  }

  const winner = entries[Math.floor(Math.random() * entries.length)];
  db.prepare(`
    UPDATE giveaways
    SET status='ended', winner_discord_id=?, winner_roblox_username=?
    WHERE id=?
  `).run(winner.discord_id, winner.roblox_username, g.id);

  const mention = `<@${winner.discord_id}>`;
  const embed = new EmbedBuilder()
    .setTitle("🎉 活动开奖！")
    .setDescription(
      `恭喜 ${mention}！\\n\\n` +
      `🏆 **中奖 Roblox 用户名：** \`${winner.roblox_username}\`\\n` +
      `🎁 **获得奖品：** **${g.prize}**\\n\\n` +
      `⏰ 请在 **24小时内联系社区 Owner** 兑换奖品。`
    )
    .setFooter({ text: reroll ? `活动 #${g.id} · 重新抽奖` : `活动 #${g.id}` })
    .setTimestamp();

  await channel.send({ content: `${mention} 🎊`, embeds: [embed] });
  return winner;
}

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    await registerCommands();
    console.log("Slash commands registered.");
  } catch (e) {
    console.error("Command registration failed:", e);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "gift") {
        if (!(await ownerOnly(interaction))) return;
        if (activeGiveaway(interaction.guildId)) {
          return interaction.reply({ content: "❌ 当前已经有一个进行中的活动，请先结束或取消。", ephemeral: true });
        }

        const prize = interaction.options.getString("prize", true);
        const durationInput = interaction.options.getString("duration", true);
        const duration = parseDuration(durationInput);
        if (!duration) {
          return interaction.reply({
            content: "❌ 时长格式错误。示例：`10m`、`30m`、`2h`、`12h`、`3d`。范围：1分钟～30天。",
            ephemeral: true
          });
        }

        const now = Date.now();
        const endAt = now + duration;
        const info = db.prepare(`
          INSERT INTO giveaways(guild_id, channel_id, prize, end_at, status, created_at)
          VALUES(?,?,?,?, 'active',?)
        `).run(interaction.guildId, targetChannel.id, prize, endAt, now);

        const g = db.prepare("SELECT * FROM giveaways WHERE id=?").get(info.lastInsertRowid);
        const targetChannel = CHANNEL_ID
          ? await client.channels.fetch(CHANNEL_ID).catch(() => null)
          : interaction.channel;
        if (!targetChannel || !targetChannel.isTextBased()) {
          return interaction.reply({ content: "❌ CHANNEL_ID 无效或 Bot 无法访问该频道。", ephemeral: true });
        }
        const msg = await targetChannel.send({ embeds: [giveawayEmbed(g)], components: [giveawayButtons(g.id)] });
        db.prepare("UPDATE giveaways SET message_id=? WHERE id=?").run(msg.id, g.id);

        await interaction.reply({ content: `✅ 活动已创建！截止时间：<t:${Math.floor(endAt / 1000)}:F>`, ephemeral: true });
      }

      else if (interaction.commandName === "giftstatus") {
        if (!(await ownerOnly(interaction))) return;
        const g = activeGiveaway(interaction.guildId);
        if (!g) return interaction.reply({ content: "目前没有进行中的活动。", ephemeral: true });
        return interaction.reply({
          content: `🎁 活动 #${g.id}\\n奖品：**${g.prize}**\\n参与人数：**${participantsCount(g.id)}**\\n剩余：**${formatRemaining(g.end_at - Date.now())}**`,
          ephemeral: true
        });
      }

      else if (interaction.commandName === "giftcancel") {
        if (!(await ownerOnly(interaction))) return;
        const g = activeGiveaway(interaction.guildId);
        if (!g) return interaction.reply({ content: "目前没有进行中的活动。", ephemeral: true });
        db.prepare("UPDATE giveaways SET status='cancelled' WHERE id=?").run(g.id);
        const ch = await interaction.guild.channels.fetch(g.channel_id).catch(() => null);
        if (ch?.isTextBased()) await ch.send(`🛑 **活动已取消**\\n奖品：**${g.prize}**\\n活动 #${g.id}`);
        return interaction.reply({ content: "✅ 活动已取消。", ephemeral: true });
      }

      else if (interaction.commandName === "gift-end") {
        if (!(await ownerOnly(interaction))) return;
        const g = activeGiveaway(interaction.guildId);
        if (!g) return interaction.reply({ content: "目前没有进行中的活动。", ephemeral: true });
        await interaction.reply({ content: "🎲 正在开奖……", ephemeral: true });
        await announceWinner(g);
      }

      else if (interaction.commandName === "gift-reroll") {
        if (!(await ownerOnly(interaction))) return;
        const g = db.prepare("SELECT * FROM giveaways WHERE guild_id=? AND status='ended' ORDER BY id DESC LIMIT 1").get(interaction.guildId);
        if (!g) return interaction.reply({ content: "没有可以重新抽奖的活动。", ephemeral: true });
        await interaction.reply({ content: "🎲 正在重新抽奖……", ephemeral: true });
        await announceWinner(g, true);
      }
    }

    else if (interaction.isButton()) {
      const [action, idStr] = interaction.customId.split(":");
      const id = Number(idStr);
      const g = db.prepare("SELECT * FROM giveaways WHERE id=?").get(id);
      if (!g) return interaction.reply({ content: "❌ 活动不存在。", ephemeral: true });

      if (action === "gift_join") {
        if (g.status !== "active" || g.end_at <= Date.now()) {
          return interaction.reply({ content: "❌ 活动已经结束。", ephemeral: true });
        }
        const exists = db.prepare("SELECT 1 FROM entries WHERE giveaway_id=? AND discord_id=?").get(id, interaction.user.id);
        if (exists) return interaction.reply({ content: "⚠️ 你已经参加过这个活动了。", ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`gift_modal:${id}`).setTitle("🎉 参加活动");
        const input = new TextInputBuilder()
          .setCustomId("roblox_username")
          .setLabel("Roblox 用户名")
          .setPlaceholder("例如：Builderman")
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(20)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (action === "gift_users") {
        const entries = db.prepare("SELECT discord_id, roblox_username FROM entries WHERE giveaway_id=? ORDER BY id ASC").all(id);
        if (!entries.length) return interaction.reply({ content: "👥 目前还没有人参加。", ephemeral: true });
        const max = 40;
        const lines = entries.slice(0, max).map((e, i) => `${i + 1}. <@${e.discord_id}> — Roblox: \`${e.roblox_username}\``);
        const more = entries.length > max ? `\\n…还有 ${entries.length - max} 人` : "";
        return interaction.reply({
          content: `👥 **活动 #${id} 参与者（${entries.length}人）**\\n\\n${lines.join("\\n")}${more}`,
          ephemeral: false
        });
      }
    }

    else if (interaction.isModalSubmit()) {
      const [action, idStr] = interaction.customId.split(":");
      if (action !== "gift_modal") return;
      const id = Number(idStr);
      const g = db.prepare("SELECT * FROM giveaways WHERE id=?").get(id);

      if (!g || g.status !== "active" || g.end_at <= Date.now()) {
        return interaction.reply({ content: "❌ 活动已经结束。", ephemeral: true });
      }

      const exists = db.prepare("SELECT 1 FROM entries WHERE giveaway_id=? AND discord_id=?").get(id, interaction.user.id);
      if (exists) return interaction.reply({ content: "⚠️ 你已经参加过这个活动了。", ephemeral: true });

      const username = interaction.fields.getTextInputValue("roblox_username").trim();
      let roblox;
      try {
        roblox = await resolveRobloxUsername(username);
      } catch {
        return interaction.reply({ content: "❌ 无法连接 Roblox 验证服务，请稍后再试。", ephemeral: true });
      }
      if (!roblox) return interaction.reply({ content: "❌ 找不到这个 Roblox 用户名，请确认用户名正确。", ephemeral: true });

      try {
        db.prepare(`
          INSERT INTO entries(giveaway_id,guild_id,discord_id,discord_tag,roblox_user_id,roblox_username,joined_at)
          VALUES(?,?,?,?,?,?,?)
        `).run(id, interaction.guildId, interaction.user.id, interaction.user.tag, roblox.id, roblox.name, Date.now());
      } catch {
        return interaction.reply({ content: "⚠️ 你已经参加过这个活动，或该 Roblox 账号已经参加过。", ephemeral: true });
      }

      const ch = await interaction.guild.channels.fetch(g.channel_id).catch(() => null);
      if (ch?.isTextBased() && g.message_id) {
        const msg = await ch.messages.fetch(g.message_id).catch(() => null);
        if (msg) await msg.edit({ embeds: [giveawayEmbed(g)], components: [giveawayButtons(g.id)] }).catch(() => {});
      }

      return interaction.reply({
        content: `✅ **参与成功！**\\n\\nDiscord：${interaction.user}\\nRoblox：\`${roblox.name}\`\\n\\n祝你好运！🎉`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Bot 发生错误，请稍后再试。", ephemeral: true }).catch(() => {});
    }
  }
});

async function processExpired() {
  const rows = db.prepare("SELECT * FROM giveaways WHERE status='active' AND end_at <= ?").all(Date.now());
  for (const g of rows) {
    try { await announceWinner(g); } catch (e) { console.error("Auto draw failed", g.id, e); }
  }
}

setInterval(processExpired, 10_000);
setInterval(async () => {
  const rows = db.prepare("SELECT * FROM giveaways WHERE status='active'").all();
  for (const g of rows) {
    if (!g.message_id) continue;
    try {
      const ch = await client.channels.fetch(g.channel_id);
      if (!ch?.isTextBased()) continue;
      const msg = await ch.messages.fetch(g.message_id);
      await msg.edit({ embeds: [giveawayEmbed(g)], components: [giveawayButtons(g.id)] });
    } catch {}
  }
}, 60_000);

const app = express();
app.get("/", (_, res) => res.send("Discord Gift Bot is online."));
app.get("/health", (_, res) => res.json({ ok: true, bot: client.user?.tag || null }));
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

client.login(TOKEN);
