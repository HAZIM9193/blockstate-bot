// ============================================
//   BlockState Mod Projector Bot - Single File
// ============================================

const { Client, GatewayIntentBits, SlashCommandBuilder,
        EmbedBuilder, REST, Routes, Events } = require('discord.js');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ══════════════════════════════
//  CONFIG — EDIT SINI
// ══════════════════════════════
const TOKEN     = process.env.DISCORD_TOKEN || 'TOKEN_KORANG';
const CLIENT_ID = process.env.CLIENT_ID     || 'CLIENT_ID_KORANG';
const GUILD_ID  = process.env.GUILD_ID      || 'GUILD_ID_KORANG';
const BLOCKSTATE_URL      = 'https://blockstate.team/p';
const MAX_VIDEO_MB        = 100;
const TIMEOUT_MINUTES     = 10;
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ══════════════════════════════
//  QUEUE
// ══════════════════════════════
const Q = {
  jobs: [], active: null, isProcessing: false,
  add(userId, videoPath, videoName) {
    const job = { id: `${Date.now()}_${userId}`, userId, videoPath, videoName,
                  status: 'queued', currentFrame: 0, totalFrames: 0, startedAt: null };
    this.jobs.push(job);
    return job;
  },
  next() { return this.jobs.shift() || null; },
  userJobs(userId) {
    const list = [];
    if (this.active?.userId === userId) list.push(this.active);
    list.push(...this.jobs.filter(j => j.userId === userId));
    return list;
  },
  all() {
    const list = [];
    if (this.active) list.push(this.active);
    list.push(...this.jobs);
    return list;
  }
};

// ══════════════════════════════
//  EMBEDS
// ══════════════════════════════
function bar(pct, len = 18) {
  const f = Math.round((pct / 100) * len);
  return `[${'█'.repeat(f)}${'░'.repeat(len - f)}]`;
}

function embedQueued(job, pos) {
  return new EmbedBuilder().setColor(0xF59E0B).setTitle('📋 Masuk Queue!')
    .setDescription(`**${job.videoName}** dah masuk queue.`)
    .addFields(
      { name: '📍 Posisi', value: `#${pos}`, inline: true },
      { name: '👤 User', value: `<@${job.userId}>`, inline: true }
    ).setTimestamp();
}

function embedProcessing(job) {
  const pct = job.totalFrames > 0 ? Math.round((job.currentFrame / job.totalFrames) * 100) : 0;
  const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
  return new EmbedBuilder().setColor(0x3B82F6).setTitle('⚙️ Processing...')
    .setDescription(`Capturing frames untuk **${job.videoName}**`)
    .addFields(
      { name: '📊 Progress', value: `${bar(pct)} **${pct}%**` },
      { name: '🎞️ Frame', value: `${job.currentFrame} / ${job.totalFrames}`, inline: true },
      { name: '⏱️ Masa', value: `${elapsed}s`, inline: true }
    ).setFooter({ text: 'Sabar ye...' }).setTimestamp();
}

function embedDone(job, url) {
  return new EmbedBuilder().setColor(0x22C55E).setTitle('✅ Siap! Download Sekarang!')
    .setDescription(`**${job.videoName}** dah selesai diproses! 🎉`)
    .addFields(
      { name: '📥 Download', value: url ? `[Klik sini](${url})` : 'Pergi website BlockState untuk download.' },
      { name: '🎮 Cara Install', value: '1. Download `.mcaddon`\n2. Double-click install\n3. Enable dalam Minecraft > Add-Ons' }
    ).setTimestamp();
}

function embedError(title, desc) {
  return new EmbedBuilder().setColor(0xEF4444).setTitle(`❌ ${title}`).setDescription(desc).setTimestamp();
}

function embedHelp() {
  return new EmbedBuilder().setColor(0x6B21A8).setTitle('🎮 BlockState Projector Bot')
    .setDescription('Bot auto-upload video dan download Mod Projector untuk Minecraft Bedrock!')
    .addFields(
      { name: '📋 Commands', value: '`/upload` - Upload video\n`/queue` - Tengok queue\n`/status` - Status video korang\n`/help` - Menu ni' },
      { name: '📝 Cara Guna', value: '1️⃣ Rename video (nama = nama in-game)\n2️⃣ `/upload` + attach video\n3️⃣ Tunggu bot process\n4️⃣ Download mod!' },
      { name: '⚠️ Had', value: 'Max 5 video • Max 100MB • Format: MP4, MOV, AVI, MKV' }
    ).setTimestamp();
}

function embedQueue() {
  const all = Q.all();
  const e = new EmbedBuilder().setColor(0x6B21A8).setTitle('📊 Queue Status').setTimestamp();
  if (!Q.active && Q.jobs.length === 0) {
    return e.setDescription('✅ Queue kosong! Guna `/upload` sekarang.');
  }
  if (Q.active) {
    const pct = Q.active.totalFrames > 0 ? Math.round((Q.active.currentFrame / Q.active.totalFrames) * 100) : 0;
    e.addFields({ name: '⚙️ Sedang Diproses', value: `**${Q.active.videoName}** oleh <@${Q.active.userId}>\n${bar(pct)} ${pct}%` });
  }
  if (Q.jobs.length > 0) {
    e.addFields({ name: `📋 Queue (${Q.jobs.length})`, value: Q.jobs.slice(0, 10).map((j, i) => `${i+1}. **${j.videoName}** — <@${j.userId}>`).join('\n') });
  }
  return e;
}

// ══════════════════════════════
//  AUTOMATOR (Puppeteer)
// ══════════════════════════════
async function runAutomation(videoPath, onProgress) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto(BLOCKSTATE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Expose hidden file inputs
    await page.evaluate(() => {
      document.querySelectorAll('input[type="file"]').forEach(el => {
        el.style.cssText = 'display:block!important;opacity:1!important;position:relative!important;width:100px;height:50px';
      });
    });

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('Tak jumpa upload input. Cuba semak website BlockState.');

    await fileInput.uploadFile(videoPath);
    await new Promise(r => setTimeout(r, 2000));

    // Click upload button
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent.trim().toLowerCase() === 'upload') btn.click();
      });
    });

    // Monitor progress
    const timeout = TIMEOUT_MINUTES * 60 * 1000;
    const start = Date.now();
    let lastFrame = 0;

    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 2500));

      const progress = await page.evaluate(() => {
        const m = document.body.innerText.match(/Capturing frame (\d+) of (\d+)/i);
        return m ? { cur: +m[1], total: +m[2] } : null;
      });

      if (progress && progress.cur !== lastFrame) {
        lastFrame = progress.cur;
        onProgress(progress.cur, progress.total);
      }

      const dlUrl = await page.evaluate(() => {
        for (const el of document.querySelectorAll('a[href]')) {
          if (el.href.includes('.mcaddon') || el.href.includes('.mcpack') ||
              el.textContent.toLowerCase().includes('download now')) return el.href;
        }
        return null;
      });

      if (dlUrl) { onProgress(100, 100); return dlUrl; }
      if (!progress && lastFrame > 0) {
        await new Promise(r => setTimeout(r, 3000));
        const dlUrl2 = await page.evaluate(() => {
          for (const el of document.querySelectorAll('a[href]')) {
            if (el.href.includes('.mcaddon') || el.href.includes('.mcpack') ||
                el.textContent.toLowerCase().includes('download now')) return el.href;
          }
          return null;
        });
        if (dlUrl2) return dlUrl2;
      }
    }
    throw new Error('Timeout! Video terlalu panjang atau website ada masalah.');
  } finally {
    await browser.close();
  }
}

// ══════════════════════════════
//  DOWNLOAD FROM DISCORD
// ══════════════════════════════
function dlFile(url, dest) {
  return new Promise((res, rej) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        file.close(); fs.unlinkSync(dest);
        return dlFile(r.headers.location, dest).then(res).catch(rej);
      }
      r.pipe(file);
      file.on('finish', () => file.close(res));
    }).on('error', e => { fs.unlink(dest, () => {}); rej(e); });
  });
}

// ══════════════════════════════
//  QUEUE PROCESSOR
// ══════════════════════════════
async function processQueue(client) {
  if (Q.isProcessing || Q.jobs.length === 0) return;
  Q.isProcessing = true;
  Q.active = Q.next();
  Q.active.status = 'processing';
  Q.active.startedAt = Date.now();

  let progressMsg = null;
  let lastUpdate = 0;
  const job = Q.active;

  try {
    const channel = await client.channels.fetch(job.channelId);

    const dlUrl = await runAutomation(job.videoPath, async (cur, total) => {
      job.currentFrame = cur;
      job.totalFrames = total;
      const now = Date.now();
      if (now - lastUpdate > 5000) {
        lastUpdate = now;
        try {
          if (!progressMsg) {
            progressMsg = await channel.send({ content: `<@${job.userId}>`, embeds: [embedProcessing(job)] });
          } else {
            await progressMsg.edit({ embeds: [embedProcessing(job)] });
          }
        } catch (e) {}
      }
    });

    const doneEmbed = embedDone(job, dlUrl);
    if (progressMsg) {
      await progressMsg.edit({ content: `🎉 <@${job.userId}> Mod dah siap!`, embeds: [doneEmbed] });
    } else {
      await channel.send({ content: `🎉 <@${job.userId}> Mod dah siap!`, embeds: [doneEmbed] });
    }

    try {
      const user = await client.users.fetch(job.userId);
      await user.send({ content: '🎮 Mod korang dah siap!', embeds: [doneEmbed] });
    } catch (e) {}

  } catch (err) {
    try {
      const channel = await client.channels.fetch(job.channelId);
      const e = embedError('Processing Gagal', `${err.message}\n\nCuba lagi atau pergi [website BlockState](https://blockstate.team) manual.`);
      if (progressMsg) await progressMsg.edit({ content: `❌ <@${job.userId}>`, embeds: [e] });
      else await channel.send({ content: `❌ <@${job.userId}>`, embeds: [e] });
    } catch (e2) {}
  } finally {
    try { if (fs.existsSync(job.videoPath)) fs.unlinkSync(job.videoPath); } catch (e) {}
    Q.active = null;
    Q.isProcessing = false;
    if (Q.jobs.length > 0) setTimeout(() => processQueue(client), 1000);
  }
}

// ══════════════════════════════
//  REGISTER COMMANDS
// ══════════════════════════════
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('upload').setDescription('Upload video untuk Mod Projector')
      .addAttachmentOption(o => o.setName('video').setDescription('Video (rename dulu!)').setRequired(true))
      .addStringOption(o => o.setName('nama').setDescription('Nama in-game (optional)').setRequired(false)),
    new SlashCommandBuilder().setName('queue').setDescription('Tengok queue sekarang'),
    new SlashCommandBuilder().setName('status').setDescription('Check status video korang'),
    new SlashCommandBuilder().setName('help').setDescription('Cara guna bot'),
  ].map(c => c.toJSON());

  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commands registered!');
  } catch (e) {
    console.error('❌ Register commands failed:', e.message);
  }
}

// ══════════════════════════════
//  BOT CLIENT
// ══════════════════════════════
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, async (c) => {
  console.log(`\n✅ Bot online: ${c.user.tag}`);
  c.user.setActivity('Minecraft Bedrock | /help', { type: 0 });
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /help ──
  if (interaction.commandName === 'help') {
    return interaction.reply({ embeds: [embedHelp()], ephemeral: true });
  }

  // ── /queue ──
  if (interaction.commandName === 'queue') {
    return interaction.reply({ embeds: [embedQueue()] });
  }

  // ── /status ──
  if (interaction.commandName === 'status') {
    const jobs = Q.userJobs(interaction.user.id);
    if (jobs.length === 0) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x6B7280).setTitle('📭 Tiada Video').setDescription('Takde video dalam queue. Guna `/upload`!')], ephemeral: true });
    }
    const fields = jobs.map((j, i) => {
      const pct = j.totalFrames > 0 ? Math.round((j.currentFrame / j.totalFrames) * 100) : 0;
      const statusMap = { queued: `⏳ Queue #${i+1}`, processing: `⚙️ Processing ${pct}%`, completed: '✅ Siap', failed: `❌ Gagal` };
      return { name: `${i+1}. ${j.videoName}`, value: statusMap[j.status] || j.status, inline: false };
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x6B21A8).setTitle('📊 Status Video').addFields(fields).setTimestamp()], ephemeral: true });
  }

  // ── /upload ──
  if (interaction.commandName === 'upload') {
    await interaction.deferReply();
    const attachment = interaction.options.getAttachment('video');
    const customName = interaction.options.getString('nama');

    if (!attachment) return interaction.editReply({ embeds: [embedError('Tiada Video', 'Attach video sekali dengan command!')] });

    const sizeMB = attachment.size / (1024 * 1024);
    if (sizeMB > MAX_VIDEO_MB) return interaction.editReply({ embeds: [embedError('File Terlalu Besar', `Max ${MAX_VIDEO_MB}MB. Video korang ${sizeMB.toFixed(1)}MB.`)] });

    const isVideo = attachment.name.match(/\.(mp4|mov|avi|mkv|webm)$/i) || (attachment.contentType || '').includes('video');
    if (!isVideo) return interaction.editReply({ embeds: [embedError('Format Salah', 'Guna format MP4, MOV, AVI, MKV atau WEBM.')] });

    if (Q.userJobs(interaction.user.id).length >= 5) return interaction.editReply({ embeds: [embedError('Had Dicapai', 'Max 5 video dalam queue. Tunggu yang sebelumnya selesai!')] });

    const videoName = customName || path.basename(attachment.name, path.extname(attachment.name));
    const tempPath = path.join(TEMP_DIR, `${Date.now()}_${attachment.name}`);

    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x6B21A8).setTitle('⬇️ Downloading...').setDescription(`Downloading **${attachment.name}** (${sizeMB.toFixed(1)}MB)`)] });

    try {
      await dlFile(attachment.url, tempPath);
    } catch (e) {
      return interaction.editReply({ embeds: [embedError('Download Gagal', e.message)] });
    }

    const job = Q.add(interaction.user.id, tempPath, videoName);
    job.channelId = interaction.channelId;

    await interaction.editReply({ embeds: [embedQueued(job, Q.jobs.length)] });
    processQueue(client);
  }
});

client.login(TOKEN);
