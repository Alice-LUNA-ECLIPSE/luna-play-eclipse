const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Включаем поддержку мульти-аудиодорожек и встроенных (inband) субтитров Chromium
app.commandLine.appendSwitch('disable-features', 'IOSurfaceCapturer');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks,InbandTextTracks');

const gotTheLock = app.requestSingleInstanceLock();
let win;

// === UNIFIED LOGGING SYSTEM ===
const baseDir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
const logDir = path.join(baseDir, 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'error_log.txt');

function writeLog(processName, message, stackTrace) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [Process: ${processName}] [${message}]\nStack Trace:\n${stackTrace || 'N/A'}\n----------------------------------------\n`;
    try {
        fs.appendFileSync(logFile, logEntry);
    } catch (e) {}
    console.error(logEntry);
}

process.on('uncaughtException', (error) => {
    writeLog('Main', error.message, error.stack);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : 'N/A';
    writeLog('Main', `Unhandled Rejection: ${msg}`, stack);
});

ipcMain.on('log-error', (event, { message, stack }) => {
    writeLog('Renderer', message, stack);
});

// === DISCORD RPC ===
let rpc;
let rpcReady = false;
try {
    const DiscordRPC = require('discord-rpc');
    const clientId = '123456789012345678';
    DiscordRPC.register(clientId);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });

    rpc.on('ready', () => { rpcReady = true; });
    rpc.login({ clientId }).catch(() => { console.log("Discord не запущен"); });
} catch (err) {
    writeLog('Main (Discord)', "Discord RPC модуль не найден. Запустите 'npm install discord-rpc'", err.stack);
}

const SUPPORTED_EXT = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.mp3', '.flac', '.wav', '.ogg', '.mka', '.aac'];

function filterMediaFiles(args) {
    return args.filter(arg => {
        const lower = arg.toLowerCase();
        return SUPPORTED_EXT.some(ext => lower.endsWith(ext));
    });
}

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
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
        width: 1280,
        height: 740,
        minWidth: 520,
        minHeight: 340,
        backgroundColor: '#09090c',
        title: "Luna Play Engine",
        icon: path.join(__dirname, 'build/icon.ico'),
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#0a0a0e', symbolColor: '#ffffff', height: 36 },
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            experimentalFeatures: true,
            enableBlinkFeatures: 'AudioVideoTracks,InbandTextTracks'
        }
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

    ipcMain.on('update-titlebar', (event, { color, symbolColor }) => {
        if (win && typeof win.setTitleBarOverlay === 'function') {
            try {
                win.setTitleBarOverlay({
                    color: color || '#0a0a0e',
                    symbolColor: symbolColor || '#ffffff',
                    height: 36
                });
            } catch (e) {}
        }
    });

    win.webContents.on('did-finish-load', () => {
        const initialFiles = filterMediaFiles(process.argv);
        if (initialFiles.length > 0) {
            setTimeout(() => win.webContents.send('open-files', initialFiles), 200);
        }
    });

    ipcMain.on('toggle-pin', (e, state) => { if (win) win.setAlwaysOnTop(state); });
    ipcMain.on('window-minimize', () => { if (win) win.minimize(); });
    ipcMain.on('window-restore', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

    // Открытие Проводника с выделением файла
    ipcMain.on('show-item-in-folder', (e, filePath) => {
        if (filePath && fs.existsSync(filePath)) {
            shell.showItemInFolder(path.normalize(filePath));
        }
    });

    // Получение точных данных о файле с диска (размер, даты)
    ipcMain.handle('get-file-stats', async (e, filePath) => {
        try {
            if (filePath && fs.existsSync(filePath)) {
                const st = fs.statSync(filePath);
                return { size: st.size, mtime: st.mtimeMs, birthtime: st.birthtimeMs };
            }
        } catch (err) {}
        return null;
    });

    ipcMain.on('update-rpc', async (e, data) => {
        if (!rpc || !rpcReady) return;
        if (!data.enabled) {
            rpc.clearActivity().catch(() => {});
            return;
        }
        try {
            const activity = {
                details: data.file ? `Смотрит: ${data.file}` : 'Выбирает видео',
                state: data.paused ? 'На паузе' : 'Воспроизведение',
                largeImageKey: 'luna_icon',
                largeImageText: 'Luna Play Engine v3.5',
                instance: false,
            };
            if (!data.paused && data.startTimestamp) {
                activity.startTimestamp = data.startTimestamp;
            }
            await rpc.setActivity(activity);
        } catch (err) {
            writeLog('Main (Discord)', `SetActivity error: ${err.message}`, err.stack);
        }
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});