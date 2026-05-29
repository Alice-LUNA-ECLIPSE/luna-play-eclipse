const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Оптимизация для захвата окна трансляцией Discord 
app.commandLine.appendSwitch('disable-features', 'IOSurfaceCapturer');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'AudioVideoTracks');

const gotTheLock = app.requestSingleInstanceLock();
let win;

// === UNIFIED LOGGING SYSTEM ===
// Для dev: папка logs в корне проекта. Для prod (сборка): папка logs в AppData.
const baseDir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
const logDir = path.join(baseDir, 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'error_log.txt');

function writeLog(processName, message, stackTrace) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [Process: ${processName}] [${message}]\nStack Trace:\n${stackTrace || 'N/A'}\n----------------------------------------\n`;
    fs.appendFileSync(logFile, logEntry);
    console.error(logEntry); // Дублируем в консоль для удобства при разработке
}

// Глобальный перехват ошибок Main Process
process.on('uncaughtException', (error) => {
    writeLog('Main', error.message, error.stack);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : 'N/A';
    writeLog('Main', `Unhandled Rejection: ${msg}`, stack);
});

// IPC слушатель для Renderer Process
ipcMain.on('log-error', (event, { message, stack }) => {
    writeLog('Renderer', message, stack);
});
// ==============================

// Инициализация Discord RPC
let rpc;
let rpcReady = false;
try {
    const DiscordRPC = require('discord-rpc');
    const clientId = '123456789012345678'; // Укажите свой Client ID
    DiscordRPC.register(clientId);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    
    rpc.on('ready', () => { rpcReady = true; });
    rpc.login({ clientId }).catch(() => { console.log("Discord не запущен"); });
} catch (err) {
    writeLog('Main (Discord)', "Discord RPC модуль не найден. Запустите 'npm install discord-rpc'", err.stack);
}

function filterMediaFiles(args) {
    return args.filter(arg => {
        const lower = arg.toLowerCase();
        return lower.endsWith('.mp4') || lower.endsWith('.mkv') || lower.endsWith('.avi') || lower.endsWith('.webm');
    });
}

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
            const newFiles = filterMediaFiles(commandLine);
            if (newFiles.length > 0) win.webContents.send('open-files', newFiles);
        }
    });
    app.whenReady().then(createWindow);
}

function createWindow() {
    win = new BrowserWindow({
        width: 1280, height: 720,
        minWidth: 400, minHeight: 250,
        backgroundColor: '#000000',
        title: "Luna Play Engine",
        icon: path.join(__dirname, 'build/icon.ico'), 
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#0a0a0c', symbolColor: '#ffffff', height: 35 },
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
    });

    win.loadFile('index.html');

    ipcMain.on('clear-app-cache', async (event) => {
    if (win && win.webContents) {
        try {
            const session = win.webContents.session;
            await session.clearCache();
            await session.clearStorageData({
                storages: ['appcache', 'serviceworkers', 'cachestorage']
            });
            event.reply('clear-cache-success');
        } catch (err) {
            writeLog('Main (Cache)', `Cache clear error: ${err.message}`, err.stack);
            event.reply('clear-cache-error', err.message);
        }
    }
});

    win.webContents.on('did-finish-load', () => {
        const initialFiles = filterMediaFiles(process.argv);
        if (initialFiles.length > 0) setTimeout(() => win.webContents.send('open-files', initialFiles), 200);
    });

    ipcMain.on('toggle-pin', (e, state) => { if (win) win.setAlwaysOnTop(state); });
    ipcMain.on('window-minimize', () => { if (win) win.minimize(); });
    ipcMain.on('window-restore', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
    
    // Обновление статуса в Discord
    ipcMain.on('update-rpc', async (e, data) => {
        if (!rpc || !rpcReady) return;
        if (!data.enabled) {
            rpc.clearActivity();
            return;
        }
        try {
            await rpc.setActivity({
                details: data.file ? `Смотрит: ${data.file}` : 'Выбирает видео',
                state: data.paused ? 'На паузе' : 'Воспроизведение',
                startTimestamp: data.paused ? null : data.startTimestamp,
                largeImageKey: 'luna_icon', 
                largeImageText: 'Luna Play Engine v3.0',
                instance: false,
            });
        } catch (err) {
            writeLog('Main (Discord)', `SetActivity error: ${err.message}`, err.stack);
        }
    });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });