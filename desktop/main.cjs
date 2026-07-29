const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");

let mainWindow;
const activeProcesses = new Map();
const cancelledJobs = new Set();

const isWindows = process.platform === "win32";
const engineDir = () => path.join(app.getPath("userData"), "engine");
const ytdlpPath = () => path.join(engineDir(), isWindows ? "yt-dlp.exe" : "yt-dlp");
const ffmpegPath = () => path.join(engineDir(), isWindows ? "ffmpeg.exe" : "ffmpeg");

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(url, { headers: { "User-Agent": "FluxSave/1.0" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close();
        fs.unlink(destination, () => {});
        if (redirects > 8) return reject(new Error("Too many download redirects."));
        const next = new URL(response.headers.location, url).toString();
        return downloadFile(next, destination, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`Engine download failed (${response.statusCode}).`));
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    request.on("error", (error) => {
      file.close();
      fs.unlink(destination, () => {});
      reject(error);
    });
  });
}

async function ensureEngine() {
  await fsp.mkdir(engineDir(), { recursive: true });
  if (!fs.existsSync(ytdlpPath())) {
    send("engine-status", "Installing the video engine…");
    await downloadFile(
      isWindows
        ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
      ytdlpPath()
    );
    if (!isWindows) await fsp.chmod(ytdlpPath(), 0o755);
  }
  if (!fs.existsSync(ffmpegPath())) {
    send("engine-status", "Installing the audio engine…");
    const archive = path.join(engineDir(), "ffmpeg.zip");
    await downloadFile(
      isWindows
        ? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        : "https://evermeet.cx/ffmpeg/getrelease/zip",
      archive
    );
    const zip = new AdmZip(archive);
    const entry = zip.getEntries().find((item) => {
      const normalized = item.entryName.replaceAll("\\", "/");
      return isWindows
        ? normalized.endsWith("/bin/ffmpeg.exe")
        : normalized === "ffmpeg" || normalized.endsWith("/ffmpeg");
    });
    if (!entry) throw new Error("The audio engine archive was invalid.");
    await fsp.writeFile(ffmpegPath(), entry.getData());
    if (!isWindows) await fsp.chmod(ffmpegPath(), 0o755);
    await fsp.unlink(archive);
  }
  send("engine-status", "Ready");
  return { ytdlp: ytdlpPath(), ffmpeg: ffmpegPath() };
}

function run(executable, args, onLine, processKey = `system-${Date.now()}-${Math.random()}`) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(executable, args, { windowsHide: true });
    activeProcesses.set(processKey, childProcess);
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitLines = (value, bufferName) => {
      const combined = (bufferName === "stdout" ? stdoutBuffer : stderrBuffer) + value;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() || "";
      if (bufferName === "stdout") stdoutBuffer = remainder;
      else stderrBuffer = remainder;
      if (onLine) lines.forEach((line) => onLine(line));
    };
    childProcess.stdout.on("data", (data) => {
      stdout += data;
      emitLines(data.toString(), "stdout");
    });
    childProcess.stderr.on("data", (data) => {
      stderr += data;
      emitLines(data.toString(), "stderr");
    });
    childProcess.on("error", reject);
    childProcess.on("close", (code) => {
      if (onLine && stdoutBuffer) onLine(stdoutBuffer);
      if (onLine && stderrBuffer) onLine(stderrBuffer);
      if (activeProcesses.get(processKey) === childProcess) activeProcesses.delete(processKey);
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim().split("\n").pop() || "Processing failed."));
    });
  });
}

function safeBase(value) {
  return (value || "FluxSave download").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 150);
}

async function reserveDestination(folder, filename) {
  const parsed = path.parse(path.basename(filename));
  const stem = safeBase(parsed.name);
  const extension = parsed.ext.toLowerCase();
  for (let index = 0; ; index += 1) {
    const suffix = index ? ` (${index})` : "";
    const candidate = path.join(folder, `${stem}${suffix}${extension}`);
    if (fs.existsSync(candidate)) continue;
    const lockPath = path.join(folder, `.${path.basename(candidate)}.fluxsave.lock`);
    try {
      const lock = await fsp.open(lockPath, "wx");
      await lock.close();
      if (fs.existsSync(candidate)) {
        await fsp.rm(lockPath, { force: true });
        continue;
      }
      return { destination: candidate, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function publishCompletedFile(source, folder) {
  const reservation = await reserveDestination(folder, path.basename(source));
  const { destination, lockPath } = reservation;
  try {
    try {
      await fsp.rename(source, destination);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      const temporaryDestination = path.join(
        folder,
        `.${path.basename(destination)}.fluxsave-${Date.now()}.part`
      );
      try {
        await fsp.copyFile(source, temporaryDestination);
        await fsp.rename(temporaryDestination, destination);
      } finally {
        await fsp.rm(temporaryDestination, { force: true }).catch(() => {});
      }
    }
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
  return destination;
}

async function convertToH264Mp4(engine, source, destination, height, onLine, jobId) {
  const bitrate = height >= 4320 ? "45M" : height >= 2160 ? "22M" : "12M";
  const encoders = process.platform === "darwin"
    ? [
        {
          name: "Apple hardware",
          args: [
            "-c:v", "h264_videotoolbox",
            "-allow_sw", "1",
            "-realtime", "true",
            "-prio_speed", "true",
            "-profile:v", "high",
            "-b:v", bitrate
          ]
        },
        {
          name: "fast compatible",
          args: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "21"]
        }
      ]
    : [
        {
          name: "fast compatible",
          args: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "21"]
        }
      ];
  let lastError;
  for (const encoder of encoders) {
    try {
      send("engine-status", `Converting with ${encoder.name} H.264…`);
      await run(engine.ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", source,
        "-map", "0:v:0", "-map", "0:a?",
        ...encoder.args,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-max_muxing_queue_size", "4096",
        "-movflags", "+faststart",
        "-progress", "pipe:2", "-nostats",
        destination
      ], onLine, jobId);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(destination, { force: true }).catch(() => {});
      if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
      if (encoder !== encoders[encoders.length - 1]) {
        send("engine-status", "Hardware encoder unavailable; switching to fast compatible mode…");
      }
    }
  }
  throw lastError || new Error("H.264 conversion failed.");
}

function authenticationArgs(auth) {
  if (!auth?.useBrowserCookies) return [];
  const allowed = new Set(["chrome", "chromium", "edge", "firefox", "safari"]);
  const browser = allowed.has(auth.browser) ? auth.browser : (process.platform === "darwin" ? "safari" : "chrome");
  if (process.platform === "win32" && browser === "safari") {
    throw new Error("Safari login is only available on macOS. Choose Chrome, Edge, or Firefox.");
  }
  return ["--cookies-from-browser", browser];
}

function friendlyError(error) {
  const message = error?.message || "Processing failed.";
  if (/login|cookie|private|requested content is not available|not available/i.test(message)) {
    return new Error("This media needs account access. Log into Instagram in the selected browser, close and reopen that browser if needed, then enable “Use my browser login”.");
  }
  return error;
}

ipcMain.handle("analyze", async (_event, request) => {
  const engine = await ensureEngine();
  const url = typeof request === "string" ? request : request?.url;
  try {
    const output = await run(engine.ytdlp, [
      "--dump-single-json", "--no-playlist", "--no-warnings",
      ...authenticationArgs(request?.auth), "--", url
    ]);
    const info = JSON.parse(output);
    const heights = [...new Set((info.formats || [])
      .filter((format) =>
        format.height &&
        typeof format.vcodec === "string" &&
        format.vcodec !== "none"
      )
      .map((format) => Number(format.height)))]
      .sort((a, b) => b - a)
      .slice(0, 12);
    const labeledHeights = (info.formats || []).flatMap((format) => {
      const match = `${format.format_note || ""} ${format.resolution || ""}`.match(/\b(4320|2160|1440|1080|720|480|360|240|144)p\b/i);
      return match ? [Number(match[1])] : [];
    });
    const maxHeight = Math.max(heights[0] || 0, ...labeledHeights, Number(info.height) || 0);
    const standardHeights = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144]
      .filter((height) => height <= maxHeight);
    return {
      title: info.title || "Untitled video",
      thumbnail: info.thumbnail || "",
      duration: info.duration || 0,
      platform: info.extractor_key || info.extractor || "Video",
      isStory: /instagram.*story/i.test(`${info.extractor_key || ""} ${info.webpage_url || url}`),
      resolutions: standardHeights,
      sourceHeight: maxHeight
    };
  } catch (error) {
    throw friendlyError(error);
  }
});

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: app.getPath("downloads")
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("download", async (_event, job) => {
  const jobId = String(job.id || `download-${Date.now()}-${Math.random()}`);
  cancelledJobs.delete(jobId);
  const engine = await ensureEngine();
  const folder = job.folder || app.getPath("downloads");
  await fsp.mkdir(folder, { recursive: true });
  const workFolder = await fsp.mkdtemp(path.join(app.getPath("temp"), "fluxsave-"));
  try {
  const template = path.join(workFolder, "%(title).140B.%(ext)s");
  const args = [
    "--newline", "--no-playlist", "--no-warnings",
    "--continue", "--part",
    "--retries", "10",
    "--fragment-retries", "20",
    "--file-access-retries", "5",
    "--retry-sleep", "http:exp=1:20",
    "--retry-sleep", "fragment:exp=1:20",
    "--progress-template", "download:fluxsave:%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s",
    ...authenticationArgs(job.auth),
    "--ffmpeg-location", engine.ffmpeg,
    "-o", template
  ];
  let requiresH264Conversion = false;
  if (job.mode === "audio") {
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", `${job.quality || 320}K`);
  } else {
    const requestedHeight = job.quality === "best"
      ? Number(job.sourceHeight || 0)
      : Number(job.quality);
    requiresH264Conversion = requestedHeight > 1080;
    const h264Mp4Format = `bestvideo[vcodec^=avc1]${job.quality === "best" ? "" : `[height<=${Number(job.quality)}]`}+bestaudio[acodec^=mp4a]/best[vcodec^=avc1][acodec^=mp4a]${job.quality === "best" ? "" : `[height<=${Number(job.quality)}]`}`;
    const format = job.quality === "best"
      ? requiresH264Conversion ? "bestvideo+bestaudio/best" : h264Mp4Format
      : !requiresH264Conversion
        ? h264Mp4Format
        : `bestvideo[height<=${Number(job.quality)}]+bestaudio/best[height<=${Number(job.quality)}]`;
    args.push("-f", format);
    if (requiresH264Conversion) {
      args.push(
        "--merge-output-format", "mkv"
      );
    } else {
      args.push(
        "--merge-output-format", "mp4",
        "--remux-video", "mp4"
      );
    }
  }
  args.push("--print", "after_move:filepath", "--", job.url);
  let lastPath = "";
  let output;
  let lastError;
  for (const fragmentCount of [12, 6, 3, 1]) {
    if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
    try {
      output = await run(engine.ytdlp, [
        "--concurrent-fragments", String(fragmentCount),
        ...args
      ], (line) => {
        const match = line.match(/fluxsave:\s*(\d+(?:\.\d+)?)%\|([^|]*)\|(.*)/);
        if (match) {
          const rawPercent = Number(match[1]);
          send("download-progress", {
            jobId,
            percent: requiresH264Conversion ? rawPercent * 0.7 : rawPercent,
            phase: "download",
            eta: match[2].trim(),
            speed: match[3].trim()
          });
        }
        for (const part of line.trim().split("\n")) {
          if (path.isAbsolute(part.trim())) lastPath = part.trim();
        }
      }, jobId);
      break;
    } catch (error) {
      lastError = error;
      if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
      if (fragmentCount !== 1) {
        send("engine-status", "Connection adjusted; resuming download…");
      }
    }
  }
  send("engine-status", "Ready");
  if (!output) throw friendlyError(lastError);
  const lines = output.trim().split("\n");
  const printedPath = lastPath || lines.reverse().find((line) => path.isAbsolute(line.trim()));
  const expectedExtension = job.mode === "audio" ? ".mp3" : ".mp4";
  let workFiles = await fsp.readdir(workFolder, { withFileTypes: true });
  if (requiresH264Conversion) {
    if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
    const sourceCandidates = workFiles
      .filter((entry) =>
        entry.isFile() &&
        [".mkv", ".webm", ".mp4"].includes(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => path.join(workFolder, entry.name));
    let sourcePath = printedPath && fs.existsSync(printedPath) ? printedPath : null;
    if (!sourcePath && sourceCandidates.length) {
      const sourceStats = await Promise.all(sourceCandidates.map(async (filePath) => ({
        filePath,
        modified: (await fsp.stat(filePath)).mtimeMs
      })));
      sourcePath = sourceStats.sort((a, b) => b.modified - a.modified)[0].filePath;
    }
    if (!sourcePath) throw new Error("The high-resolution source download was not found.");
    const sourceName = path.parse(sourcePath);
    const convertedPath = path.join(
      workFolder,
      `${sourceName.name}${sourceName.ext.toLowerCase() === ".mp4" ? ".fluxsave-converted" : ""}.mp4`
    );
    const conversionStartedAt = Date.now();
    let conversionSpeed = "";
    send("download-progress", { jobId, percent: 70, phase: "convert", etaSeconds: null, speed: "" });
    await convertToH264Mp4(
      engine,
      sourcePath,
      convertedPath,
      Number(job.quality === "best" ? job.sourceHeight : job.quality) || 2160,
      (line) => {
        const speedMatch = line.match(/^speed=(.+)$/);
        if (speedMatch) conversionSpeed = speedMatch[1].trim();
        const timeMatch = line.match(/^out_time_(?:us|ms)=(\d+)$/);
        if (timeMatch && Number(job.duration) > 0) {
          const convertedSeconds = Number(timeMatch[1]) / 1000000;
          const fraction = Math.max(0, Math.min(1, convertedSeconds / Number(job.duration)));
          const elapsedSeconds = (Date.now() - conversionStartedAt) / 1000;
          const etaSeconds = fraction > 0.01
            ? Math.max(0, elapsedSeconds * (1 - fraction) / fraction)
            : null;
          send("download-progress", {
            jobId,
            percent: 70 + fraction * 29,
            phase: "convert",
            etaSeconds,
            speed: conversionSpeed
          });
        }
      },
      jobId
    );
    workFiles = await fsp.readdir(workFolder, { withFileTypes: true });
  }
  const completedFiles = workFiles
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === expectedExtension)
    .map((entry) => path.join(workFolder, entry.name));
  let completedPath = printedPath &&
    path.extname(printedPath).toLowerCase() === expectedExtension &&
    fs.existsSync(printedPath)
    ? printedPath
    : null;
  if (!completedPath && completedFiles.length) {
    const stats = await Promise.all(completedFiles.map(async (filePath) => ({
      filePath,
      modified: (await fsp.stat(filePath)).mtimeMs
    })));
    completedPath = stats.sort((a, b) => b.modified - a.modified)[0].filePath;
  }
  if (!completedPath) {
    throw new Error(
      job.mode === "audio"
        ? "Audio processing did not produce an MP3 file."
        : "Video processing did not produce an H.264 MP4 file. No MKV file was saved."
    );
  }
  const completedStats = await fsp.stat(completedPath);
  if (!completedStats.isFile() || completedStats.size === 0) {
    throw new Error("Processing produced an empty file. Please try again.");
  }
  if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
  const cleanTitle = sanitizeFileName(job.title || path.parse(completedPath).name);
  const cleanWorkPath = path.join(workFolder, `${cleanTitle}${expectedExtension}`);
  if (path.resolve(completedPath) !== path.resolve(cleanWorkPath)) {
    await fsp.rm(cleanWorkPath, { force: true });
    await fsp.rename(completedPath, cleanWorkPath);
    completedPath = cleanWorkPath;
  }
  const finalPath = await publishCompletedFile(completedPath, folder);
  send("engine-status", "Ready");
  send("download-progress", { jobId, percent: 100, phase: "done", etaSeconds: 0, speed: "" });
  return { path: finalPath, name: path.basename(finalPath) };
  } finally {
    cancelledJobs.delete(jobId);
    await fsp.rm(workFolder, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle("show-file", async (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.on("cancel-download", (_event, requestedJobId) => {
  if (requestedJobId) {
    const jobId = String(requestedJobId);
    cancelledJobs.add(jobId);
    activeProcesses.get(jobId)?.kill("SIGTERM");
    return;
  }
  for (const [jobId, childProcess] of activeProcesses) {
    cancelledJobs.add(jobId);
    childProcess.kill("SIGTERM");
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 620,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f4f2eb",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
