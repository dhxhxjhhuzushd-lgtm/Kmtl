const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let clientStatus = 'disconnected';
let lastQR = null;
let retryCount = 0;
const MAX_RETRY = 5;
let isSending = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initClient() {
  try {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--single-process',
          '--no-zygote'
        ]
      }
    });

    client.on('qr', async (qr) => {
      try {
        clientStatus = 'qr';
        lastQR = await qrcode.toDataURL(qr);
        io.emit('qr', lastQR);
        io.emit('status', 'qr');
        console.log('QR Code siap di-scan');
      } catch (err) {
        console.error('Error QR:', err.message);
      }
    });

    client.on('authenticated', () => {
      io.emit('status', 'authenticated');
      console.log('Authenticated!');
    });

    client.on('ready', () => {
      clientStatus = 'ready';
      lastQR = null;
      retryCount = 0;
      io.emit('status', 'ready');
      console.log('WhatsApp siap!');
    });

    client.on('auth_failure', () => {
      clientStatus = 'disconnected';
      io.emit('status', 'auth_failure');
      console.error('Auth gagal!');
    });

    client.on('disconnected', (reason) => {
      clientStatus = 'disconnected';
      isSending = false;
      io.emit('status', 'disconnected');
      console.log('Disconnected:', reason);
      if (retryCount < MAX_RETRY) {
        retryCount++;
        console.log(`Reconnect ke-${retryCount}...`);
        setTimeout(() => initClient(), 5000);
      }
    });

    client.initialize().catch((err) => {
      console.error('Init error:', err.message);
      clientStatus = 'disconnected';
      io.emit('status', 'disconnected');
      if (retryCount < MAX_RETRY) {
        retryCount++;
        setTimeout(() => initClient(), 8000);
      }
    });

  } catch (err) {
    console.error('Client error:', err.message);
    setTimeout(() => initClient(), 8000);
  }
}

initClient();

io.on('connection', (socket) => {
  socket.emit('status', clientStatus);
  if (clientStatus === 'qr' && lastQR) socket.emit('qr', lastQR);
});

// Status
app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, isSending });
});

// Daftar chat
app.get('/api/chats', async (req, res) => {
  if (clientStatus !== 'ready')
    return res.status(400).json({ error: 'WhatsApp belum terhubung. Scan QR dulu!' });
  try {
    const chats = await client.getChats();
    const result = chats.slice(0, 50).map(c => ({
      id: c.id._serialized,
      name: c.name || c.id.user || 'Unknown',
      isGroup: c.isGroup || false,
      isChannel: c.id.server === 'newsletter',
      lastMessage: c.lastMessage ? (c.lastMessage.body || '(media)').slice(0, 60) : '-'
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil chat: ' + err.message });
  }
});

// Kirim 300 reaction
app.post('/api/react', async (req, res) => {
  if (clientStatus !== 'ready')
    return res.status(400).json({ error: 'WhatsApp belum terhubung!' });
  if (isSending)
    return res.status(400).json({ error: 'Sedang mengirim reaction, harap tunggu...' });

  const { chatId, emoji, count } = req.body;
  const totalReactions = count || 300;

  if (!chatId || !emoji)
    return res.status(400).json({ error: 'chatId dan emoji wajib diisi!' });

  // Mulai kirim di background
  isSending = true;
  res.json({ success: true, message: `Mulai mengirim ${totalReactions} reaction ${emoji}...` });

  // Proses async di background
  ;(async () => {
    try {
      io.emit('reaction_start', { total: totalReactions, emoji });

      const chat = await client.getChatById(chatId);
      if (!chat) throw new Error('Chat tidak ditemukan!');

      const messages = await chat.fetchMessages({ limit: 10 });
      if (!messages || messages.length === 0) throw new Error('Tidak ada pesan di chat ini!');

      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) throw new Error('Pesan terakhir tidak ditemukan!');

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < totalReactions; i++) {
        if (!isSending) {
          io.emit('reaction_stopped', { sent: successCount });
          break;
        }

        if (clientStatus !== 'ready') {
          io.emit('reaction_error', { message: 'WhatsApp terputus saat mengirim!', sent: successCount });
          break;
        }

        try {
          await lastMsg.react(emoji);
          successCount++;
          io.emit('reaction_progress', {
            current: successCount,
            total: totalReactions,
            emoji,
            percent: Math.round((successCount / totalReactions) * 100)
          });
        } catch (err) {
          failCount++;
          console.error(`Reaction ke-${i+1} gagal:`, err.message);
          // Jika error terlalu banyak, berhenti
          if (failCount > 20) {
            io.emit('reaction_error', { message: 'Terlalu banyak error, berhenti otomatis.', sent: successCount });
            break;
          }
        }

        // Delay antar reaction supaya tidak kena ban (300ms)
        await sleep(300);
      }

      if (successCount === totalReactions) {
        io.emit('reaction_done', { sent: successCount, emoji });
      } else {
        io.emit('reaction_done', { sent: successCount, emoji, note: `${failCount} gagal` });
      }

    } catch (err) {
      console.error('Error kirim reaction:', err.message);
      io.emit('reaction_error', { message: err.message, sent: 0 });
    } finally {
      isSending = false;
    }
  })();
});

// Stop reaction
app.post('/api/stop', (req, res) => {
  isSending = false;
  io.emit('reaction_stopped', { message: 'Dihentikan oleh pengguna' });
  res.json({ success: true, message: 'Proses dihentikan' });
});

// Logout
app.post('/api/logout', async (req, res) => {
  try {
    isSending = false;
    await client.logout();
    clientStatus = 'disconnected';
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server jalan di port ' + PORT));
