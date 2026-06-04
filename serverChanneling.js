const mqtt = require('mqtt');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================================
// 1. INISIALISASI FIREBASE ADMIN SDK
// ============================================================================
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://sibanjir-dashboard-default-rtdb.asia-southeast1.firebasedatabase.app/"
});

const db = admin.database();
const messaging = admin.messaging();

// ============================================================================
// 2. INISIALISASI TELEGRAM BOT
// ============================================================================
const botToken = '7588061052:AAFT4-FWzO9N5-BGUBm3hmNcCBAp1cXU_SQ';
const bot = new TelegramBot(botToken, { polling: true });

// Simpan Chat ID user yang daftar (Di memory sementara, akan reset jika server mati)
const subscribedUsers = new Set(); 

// [TELEGRAM COMMANDS]
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const startMsg = 
        "Hello!!\n\nSaya adalah chatBot telegram SiBanjir 💧\n\n" +
        "Tugas saya adalah :\n" +
        " - Memberikan informasi terkini dari keadaan kali\n" +
        " - Memberi peringatan secara cepat jika ada situasi darurat\n\n" +
        "Anda bisa menggunakan perintah ini :\n" +
        " - /start    → Informasi awalan\n" +
        " - /daftar   → Daftar langganan notifikasi\n" +
        " - /status   → Kondisi terkini";
    bot.sendMessage(chatId, startMsg);
});

bot.onText(/\/daftar/, (msg) => {
    const chatId = msg.chat.id;
    subscribedUsers.add(chatId);
    bot.sendMessage(chatId, `Terdaftar ✅\nChat ID (milik anda): ${chatId}`);
    console.log(`[TELEGRAM] User baru terdaftar: ${chatId}`);
});

// [TELEGRAM COMMANDS] - Menampilkan Opsi Kota
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const snapshot = await db.ref('sibanjir').once('value');

        if (!snapshot.exists()) {
            bot.sendMessage(chatId, "⚠️ Belum ada data sensor di database.");
            return;
        }

        const dataSibanjir = snapshot.val();
        const keyboard = [];
        
        for (const kota in dataSibanjir) {
            keyboard.push([{ text: `🏙️ ${kota}`, callback_data: `C|${kota}` }]);
        }

        bot.sendMessage(chatId, "Pilih Kota/Wilayah pantauan:", {
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (error) {
        console.error('🔴 [TELEGRAM ERROR] Gagal load opsi status:', error);
        bot.sendMessage(chatId, "❌ Gagal mengambil data kota dari database.");
    }
});

// [TELEGRAM CALLBACK] - Handler Klik Tombol
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data; 

    try {
        // JIKA USER KLIK KOTA -> TAMPILKAN LOKASI
        if (data.startsWith('C|')) {
            const kota = data.split('|')[1];
            
            const snapshot = await db.ref(`sibanjir/${kota}`).once('value');
            const locations = snapshot.val();
            
            const keyboard = [];
            for (const loc in locations) {
                keyboard.push([{ text: `📍 ${loc}`, callback_data: `L|${kota}|${loc}` }]);
            }
            keyboard.push([{ text: "⬅️ Kembali", callback_data: "BACK_TO_HOME" }]);

            bot.editMessageText(`Memantau *${kota}*\nSilakan pilih lokasi:`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard }
            });
        } 
        
        // JIKA USER KLIK LOKASI -> TAMPILKAN STATUS
        else if (data.startsWith('L|')) {
            const parts = data.split('|');
            const kota = parts[1];
            const lokasi = parts[2];

            const snapshot = await db.ref(`sibanjir/${kota}/${lokasi}`).once('value');
            const sensorData = snapshot.val();

            if (!sensorData) {
                bot.answerCallbackQuery(query.id, { text: "Data tidak ditemukan!" });
                return;
            }

            const waktuUpdate = sensorData.updatedAt 
                ? new Date(sensorData.updatedAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) 
                : "-";

            const statusMsg = `📍 *Status Terkini SiBanjir*\n\n` +
                              `*Wilayah : ${lokasi}* (${kota})\n` +
                              `Level   : ${sensorData.Potensi}\n` +
                              `Jarak   : ${sensorData.Jarak} cm\n` +
                              `Hujan   : ${sensorData.Hujan}\n` +
                              `Update  : ${waktuUpdate} WIB`;

            const keyboard = [
                [{ text: "🔄 Refresh Data", callback_data: `L|${kota}|${lokasi}` }],
                [{ text: "⬅️ Kembali ke Lokasi", callback_data: `C|${kota}` }]
            ];

            bot.editMessageText(statusMsg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        
        // JIKA USER KLIK KEMBALI KE HOME (KOTA)
        else if (data === 'BACK_TO_HOME') {
            const snapshot = await db.ref('sibanjir').once('value');
            const dataSibanjir = snapshot.val();
            const keyboard = [];
            
            for (const kota in dataSibanjir) {
                keyboard.push([{ text: `🏙️ ${kota}`, callback_data: `C|${kota}` }]);
            }

            bot.editMessageText("Pilih Kota/Wilayah pantauan:", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (error) {
        console.error('🔴 [TELEGRAM CALLBACK ERROR]:', error);
    }
    
    bot.answerCallbackQuery(query.id);
});


// ============================================================================
// 3. KONFIGURASI MQTT BROKER
// ============================================================================
const mqttBroker = 'mqtt://broker.hivemq.com'; 
const mqttTopic = 'telemetry/sibanjir/alat0';   

const client = mqtt.connect(mqttBroker);

// Penyimpan status terakhir ADAPTIF per id_alat
const lastStatusPerAlat = {};

client.on('connect', () => {
    console.log('═════════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log("\x1b[33m");
    console.log("=   __ _ _                  _ _      ");
    console.log("=  / _(_) |__   __ _ _ __  (_|_)_ __ ");
    console.log("=  \\ \\| | '_ \\ / _` | '_ \\ | | | '__|");
    console.log("=  _\\ \\ | |_) | (_| | | | || | | |   ");
    console.log("=  \\__/_|_.__/ \\__,_|_| |_|/ |_|_|      V.2  ||  ESP32 Server Channeling MQTT -> Firebase, FCM & Telegram");
    console.log("=                        |__/        ");
    console.log("\x1b[0m");
    console.log('═════════════════════════════════════════════════════════════════════════════════════════════════════\n');
    console.log("\x1b[33m" + '[MQTT] Terhubung ke Broker' + "\x1b[0m");
    console.log("\x1b[36m" + '[TELEGRAM] Bot SiBanjir Aktif dan Menunggu Pesan' + "\x1b[0m\n");
    client.subscribe(mqttTopic);
});

client.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        const { id_alat, kota, lokasi, jarak, suhu, hujan, potensi } = payload;

        if (!id_alat || !kota || !lokasi) {
            console.log("⚠️ [WARNING] Data diabaikan karena format tidak mengandung identitas regional (id_alat/kota/lokasi)");
            return;
        }

        console.log(`\n[DATA MASUK] [${id_alat} - ${lokasi}] Jarak: ${jarak}cm | Suhu: ${suhu}°C | Cuaca: ${hujan} | Status: ${potensi}`);

        // Update Firebase Realtime Database
        const dbRef = db.ref(`sibanjir/${kota}/${lokasi}`);
        await dbRef.set({
            Jarak: jarak,
            Suhu: suhu,
            Hujan: hujan,
            Potensi: potensi,
            updatedAt: new Date().toISOString()
        });
        console.log(`🟢 [RTDB] Firebase updated untuk path: sibanjir/${kota}/${lokasi}`);

        const previousPotensi = lastStatusPerAlat[id_alat] || "";

        // Evaluasi Trigger Notifikasi (FCM & TELEGRAM)
        if (potensi !== previousPotensi) {
            
            if (["Siaga III", "Siaga II", "Siaga I"].includes(potensi) || (potensi === "Siaga IV" && previousPotensi !== "")) {
                
                await sendFCMNotification(potensi, jarak, hujan, lokasi);
                
                let telegramAlert = `🚨 *PERINGATAN SIBANJIR*\n\n` +
                                    `Lokasi : ${lokasi}\n` +
                                    `Level  : ${potensi}\n` +
                                    `Jarak  : ${jarak} cm\n` +
                                    `Hujan  : ${hujan}\n\n`;

                if (potensi === "Siaga IV") telegramAlert += "Kondisi air kembali normal.";
                else if (potensi === "Siaga III") telegramAlert += "Pantau terus kondisi air.";
                else if (potensi === "Siaga II") telegramAlert += "Bersiaplah untuk evakuasi!";
                else if (potensi === "Siaga I") telegramAlert += "SEGERA EVAKUASI!";

                if (subscribedUsers.size > 0) {
                    subscribedUsers.forEach(chatId => {
                        bot.sendMessage(chatId, telegramAlert, { parse_mode: "Markdown" })
                           .catch(err => console.error(`🔴 [TELEGRAM ERROR] Gagal kirim ke ${chatId}:`, err.message));
                    });
                    console.log(`🚀 [TELEGRAM] Broadcast dikirim ke ${subscribedUsers.size} user terdaftar.`);
                } else {
                    console.log(`[TELEGRAM] Broadcast tertahan (Belum ada user yang /daftar)`);
                }

                lastStatusPerAlat[id_alat] = potensi;
            } else {
                console.log(`[FCM/TG] [${lokasi}] Status berubah ke '${potensi}', tidak memenuhi kualifikasi notifikasi.`);
                lastStatusPerAlat[id_alat] = potensi;
            }
        } else {
            console.log(`[FCM/TG] [${lokasi}] Status sama dengan sebelumnya ('${previousPotensi}'). Di-block (Anti-Spam).`);
        }

    } catch (error) {
        console.error('🔴 [ERROR] Gagal memproses data adaptif:', error);
    }
});

process.on('SIGINT', () => {
    console.log("\x1b[33m" + '\n\n\nProgram dihentikan. Ciao ciao! ;)' + "\x1b[0m");
    process.exit(0); 
});

// ============================================================================
// 4. FUNGSI PENGIRIMAN NOTIFIKASI FCM
// ============================================================================
async function sendFCMNotification(potensi, jarak, hujan, lokasi) {
    const lokasiClean = lokasi.toLowerCase().replace(/\s+/g, '');
    let level = "4";
    if (potensi === "Siaga I") level = "1";
    else if (potensi === "Siaga II") level = "2";
    else if (potensi === "Siaga III") level = "3";
    
    const soundName = `${lokasiClean}_siaga${level}`;
    const channelId = `channel_${soundName}`; 

    let title = "";
    let body = "";

    switch (potensi) {
        case "Siaga III":
            title = `🟡 SIAGA III - WASPADA [Wilayah: ${lokasi}]`;
            body = `Tinggi muka air meningkat menjadi ${jarak} cm (${hujan}). Mohon pantau bantaran kali ${lokasi}.`;
            break;
        case "Siaga II":
            title = `🟠 SIAGA II - SIAGA [Wilayah: ${lokasi}]`;
            body = `Peringatan! Air naik signifikan ke ${jarak} cm (${hujan}) di daerah ${lokasi}. Amankan barang.`;
            break;
        case "Siaga I":
            title = `🔴 SIAGA I - BAHAYA [Wilayah: ${lokasi}]`;
            body = `DARURAT BANJIR WILAYAH ${lokasi.toUpperCase()}! Air ${jarak} cm. SEGERA EVAKUASI!`;
            break;
        case "Siaga IV":
            title = `🟢 SIAGA IV - NORMAL [Wilayah: ${lokasi}]`;
            body = `Kondisi air di ${lokasi} telah surut dan kembali normal (${jarak} cm).`;
            break;
    }

    const message = {
        topic: 'sibanjir_alerts',
        data: { 
            title: title,
            body: body,
            lokasi: lokasi,
            potensi: potensi,
            sound_name: soundName,
            channel_id: channelId,
            jarak: jarak.toString(),
            hujan: hujan
        },
        android: {
            priority: "high"
        }
    };

    try {
        await messaging.send(message);
        console.log(`🚀 [FCM] Data Message dikirim untuk [${lokasi} - ${potensi}] via channel [${channelId}].`);
    } catch (error) {
        console.error('🔴 [FCM ERROR] Gagal mengirim Data Message:', error);
    }
}