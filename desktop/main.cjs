const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, session } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");

let mainWindow;
let activityTray;
const activeProcesses = new Map();
const cancelledJobs = new Set();
let appUpdateCheckPromise = null;
let appUpdateDownloadPromise = null;

const releaseApiUrl = "https://api.github.com/repos/lightscameratech-art/fluxsave/releases/latest";

const isWindows = process.platform === "win32";
const engineDir = () => path.join(app.getPath("userData"), "engine");
const ytdlpPath = () => path.join(engineDir(), isWindows ? "yt-dlp.exe" : "yt-dlp");
const ffmpegPath = () => path.join(engineDir(), isWindows ? "ffmpeg.exe" : "ffmpeg");
const ffprobePath = () => path.join(engineDir(), isWindows ? "ffprobe.exe" : "ffprobe");
const instagramCookiesPath = () => path.join(engineDir(), "instagram-cookies.txt");
const instagramPartition = "persist:fluxsave-instagram";

function send(channel, payload) {
  if (process.platform === "darwin" && activityTray) {
    if (channel === "download-progress" && payload && typeof payload.percent === "number") {
      const stage = payload.phase === "convert" ? "Processing" : payload.phase === "done" ? "Done" : "Downloading";
      activityTray.setTitle(` ${Math.round(payload.percent)}%`);
      activityTray.setToolTip(`FluxSave: ${stage} (${Math.round(payload.percent)}%)`);
    } else if (channel === "engine-status" && payload) {
      activityTray.setTitle(" …");
      activityTray.setToolTip(`FluxSave: ${payload}`);
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notifyDesktop(title, body) {
  if (process.platform === "darwin" && Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
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

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `FluxSave/${app.getVersion()}`
      }
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects > 8) return reject(new Error("Too many update redirects."));
        return requestJson(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Update check failed (${response.statusCode}).`));
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error("The update server returned invalid data.")); }
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error("Update check timed out.")));
    request.on("error", reject);
  });
}

function versionParts(value) {
  return String(value || "0").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function updateAssetForRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (process.platform === "darwin") {
    const architecture = process.arch === "arm64" ? /(?:arm64|apple.?silicon).*\.dmg$/i : /(?:x64|x86_64|intel).*\.dmg$/i;
    return assets.find((asset) => architecture.test(asset.name))
      || assets.find((asset) => /\.dmg$/i.test(asset.name));
  }
  if (process.platform === "win32") {
    return assets.find((asset) => /(?:setup|installer).*\.exe$/i.test(asset.name))
      || assets.find((asset) => /\.exe$/i.test(asset.name));
  }
  return null;
}

async function checkForAppUpdate() {
  if (appUpdateCheckPromise) return appUpdateCheckPromise;
  appUpdateCheckPromise = (async () => {
    const release = await requestJson(releaseApiUrl);
    const latestVersion = String(release.tag_name || release.name || "").replace(/^v/i, "");
    if (!latestVersion) throw new Error("The update server did not provide a version.");
    const asset = updateAssetForRelease(release);
    return {
      currentVersion: app.getVersion(),
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, app.getVersion()),
      releaseName: release.name || `FluxSave ${latestVersion}`,
      releaseNotes: release.body || "No release notes were provided.",
      publishedAt: release.published_at || null,
      assetAvailable: Boolean(asset),
      assetName: asset?.name || "",
      assetSize: Number(asset?.size || 0),
      assetUrl: asset?.browser_download_url || "",
      releaseUrl: release.html_url || "https://github.com/lightscameratech-art/fluxsave/releases/latest"
    };
  })();
  try { return await appUpdateCheckPromise; } finally { appUpdateCheckPromise = null; }
}

function downloadUpdateFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const temporary = `${destination}.download`;
    const file = fs.createWriteStream(temporary);
    const request = https.get(url, { headers: { "User-Agent": `FluxSave/${app.getVersion()}` } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close();
        fs.unlink(temporary, () => {});
        if (redirects > 8) return reject(new Error("Too many update download redirects."));
        return downloadUpdateFile(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(temporary, () => {});
        return reject(new Error(`Update download failed (${response.statusCode}).`));
      }
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        send("app-update-progress", {
          received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : 0
        });
      });
      response.pipe(file);
      file.on("finish", async () => {
        try {
          await new Promise((closeResolve) => file.close(closeResolve));
          await fsp.rm(destination, { force: true });
          await fsp.rename(temporary, destination);
          resolve(destination);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(60000, () => request.destroy(new Error("Update download timed out.")));
    request.on("error", (error) => {
      file.close();
      fs.unlink(temporary, () => {});
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
  if (!fs.existsSync(ffmpegPath()) || !fs.existsSync(ffprobePath())) {
    send("engine-status", "Installing the audio engine…");
    const archive = path.join(engineDir(), "ffmpeg.zip");
    await downloadFile(
      isWindows
        ? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        : "https://evermeet.cx/ffmpeg/getrelease/zip",
      archive
    );
    const zip = new AdmZip(archive);
    const entries = zip.getEntries();
    const findTool = (archiveEntries, toolName) => archiveEntries.find((item) => {
      const normalized = item.entryName.replaceAll("\\", "/");
      return isWindows
        ? normalized.endsWith(`/bin/${toolName}.exe`)
        : normalized === toolName || normalized.endsWith(`/${toolName}`);
    });
    const ffmpegEntry = findTool(entries, "ffmpeg");
    let ffprobeEntry = findTool(entries, "ffprobe");
    if (!ffmpegEntry) throw new Error("The audio engine archive did not contain ffmpeg.");
    await fsp.writeFile(ffmpegPath(), ffmpegEntry.getData());
    if (!ffprobeEntry && !isWindows) {
      const probeArchive = path.join(engineDir(), "ffprobe.zip");
      await downloadFile("https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip", probeArchive);
      const probeZip = new AdmZip(probeArchive);
      ffprobeEntry = findTool(probeZip.getEntries(), "ffprobe");
      await fsp.unlink(probeArchive);
    }
    if (!ffprobeEntry) throw new Error("The audio engine archive did not contain ffprobe.");
    await fsp.writeFile(ffprobePath(), ffprobeEntry.getData());
    if (!isWindows) {
      await fsp.chmod(ffmpegPath(), 0o755);
      await fsp.chmod(ffprobePath(), 0o755);
    }
    await fsp.unlink(archive);
  }
  send("engine-status", "Ready");
  return { ytdlp: ytdlpPath(), ffmpeg: ffmpegPath(), ffprobe: ffprobePath() };
}

async function refreshVideoEngine() {
  const destination = ytdlpPath();
  const temporary = `${destination}.update`;
  send("engine-status", "Updating the YouTube engine…");
  await fsp.rm(temporary, { force: true });
  await downloadFile(
    isWindows
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    temporary
  );
  if (!isWindows) await fsp.chmod(temporary, 0o755);
  await fsp.copyFile(temporary, destination);
  await fsp.rm(temporary, { force: true });
  if (!isWindows) await fsp.chmod(destination, 0o755);
  send("engine-status", "YouTube engine updated");
}

async function videoEngineVersion() {
  if (!fs.existsSync(ytdlpPath())) return "not installed";
  return (await run(ytdlpPath(), ["--ignore-config", "--version"])).trim();
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

// Keep the download filename helper available to all download paths.
const sanitizeFileName = safeBase;

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
  let audioCodec = "";
  try {
    audioCodec = (await run(engine.ffprobe, [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1",
      source
    ])).trim().toLowerCase();
  } catch (_) {}
  const audioArgs = audioCodec === "aac"
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "192k"];
  const encoders = process.platform === "darwin"
    ? [
        {
          name: "Apple hardware",
          args: [
            "-c:v", "h264_videotoolbox",
            "-allow_sw", "1",
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
        ...audioArgs,
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

function authenticationArgs(auth, sourceUrl = "") {
  if (/instagram\.com/i.test(String(sourceUrl)) && fs.existsSync(instagramCookiesPath())) {
    return ["--cookies", instagramCookiesPath()];
  }
  if (!auth?.useBrowserCookies) return [];
  const allowed = new Set(["chrome", "chromium", "edge", "firefox", "safari"]);
  const browser = allowed.has(auth.browser) ? auth.browser : (process.platform === "darwin" ? "safari" : "chrome");
  if (process.platform === "win32" && browser === "safari") {
    throw new Error("Safari login is only available on macOS. Choose Chrome, Edge, or Firefox.");
  }
  return ["--cookies-from-browser", browser];
}

function friendlyError(error, sourceUrl = "") {
  const message = error?.message || "Processing failed.";
  if (/requested format is not available/i.test(message)) {
    return new Error("The preferred format is unavailable. FluxSave tried its compatible MP4 fallbacks; update the video engine and try again.");
  }
  if (/403|forbidden|unable to download video data/i.test(message)) {
    return new Error("The video host rejected this request (HTTP 403). FluxSave tried alternate clients; enable browser login in Settings or try again shortly.");
  }
  if (/login|cookie|private|requested content is not available|not available/i.test(message)) {
    if (/(?:youtube\.com|youtu\.be)/i.test(String(sourceUrl))) {
      return new Error("YouTube requires a signed-in browser session for this video or is applying an anti-bot check. Log into YouTube in your selected browser, then enable “Use my browser login” in Settings and try again.");
    }
    if (/instagram/i.test(String(sourceUrl))) {
      return new Error("This Instagram media needs account access. Open Settings → Instagram session, select Sign in, complete Instagram login, then try again.");
    }
    return new Error("This media needs account access. Log into the site in the selected browser, then enable “Use my browser login” in Settings.");
  }
  return error;
}

const isPinterestUrl = (url) => /^https?:\/\/(?:www\.)?pinterest\.[^/]+\//i.test(String(url || ""));
const isSpotifyUrl = (url) => /^https?:\/\/(?:open\.)?spotify\.com\//i.test(String(url || ""));

function readPage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 FluxSave/1.0" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects > 6) return reject(new Error("Too many redirects while reading Pinterest."));
        return readPage(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Pinterest returned HTTP ${response.statusCode}.`));
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 12 * 1024 * 1024) response.destroy(new Error("Pinterest page is too large."));
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i");
  return decodeHtml((html.match(pattern) || html.match(reverse) || [])[1] || "");
}

async function pinterestInfo(url) {
  const html = await readPage(url);
  const directUrl = metaContent(html, "og:video:secure_url") || metaContent(html, "og:video") || metaContent(html, "twitter:player:stream");
  if (!directUrl) throw new Error("Pinterest did not expose a public video for this Pin.");
  return {
    title: metaContent(html, "og:title") || "Pinterest video",
    thumbnail: metaContent(html, "og:image"),
    duration: 0,
    platform: "Pinterest",
    resolutions: [],
    sourceHeight: 0,
    directUrl
  };
}

ipcMain.handle("analyze", async (_event, request) => {
  const url = typeof request === "string" ? request : request?.url;
  if (isSpotifyUrl(url)) {
    throw new Error("Spotify tracks are DRM-protected. FluxSave cannot download or bypass Spotify streams.");
  }
  const engine = await ensureEngine();
  try {
    const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(String(url || ""));
    let isPlaylist = false;
    try {
      const parsedUrl = new URL(url);
      isPlaylist = isYouTube && (parsedUrl.searchParams.has("list") || /\/playlist\/?$/i.test(parsedUrl.pathname));
    } catch (_) {}
    const inspectionArgs = isPlaylist
      ? ["--dump-single-json", "--flat-playlist"]
      : ["--dump-single-json", "--no-playlist"];
    const clientVariants = isYouTube
      ? [[], ["--extractor-args", "youtube:player_client=web_safari"], ["--extractor-args", "youtube:player_client=android"]]
      : [[]];
    let output = "";
    let analyzeError;
    for (const clientArgs of clientVariants) {
      try {
        output = await run(engine.ytdlp, [
          ...clientArgs,
          ...inspectionArgs, "--no-warnings",
          ...authenticationArgs(request?.auth, url), "--", url
        ]);
        break;
      } catch (error) {
        analyzeError = error;
        if (isYouTube) send("engine-status", "YouTube check blocked; trying another player…");
      }
    }
    const analyzeMessage = String(analyzeError?.message || analyzeError || "");
    const shouldRefreshEngine = /sign in|confirm.+not.+bot|403|forbidden|player response|nsig|signature/i.test(analyzeMessage);
    if (!output && isYouTube && shouldRefreshEngine) {
      try {
        await refreshVideoEngine();
        output = await run(engine.ytdlp, [
          ...inspectionArgs, "--no-warnings",
          ...authenticationArgs(request?.auth, url), "--", url
        ]);
      } catch (error) {
        analyzeError = error;
      }
    }
    if (!output) throw analyzeError || new Error("Video inspection failed.");
    const info = JSON.parse(output);
    if (isYouTube && Array.isArray(info.entries)) {
      const entries = info.entries.flatMap((entry) => {
        if (!entry) return [];
        const candidate = entry.webpage_url || entry.original_url || entry.url || entry.id;
        const entryUrl = /^https?:\/\//i.test(String(candidate || ""))
          ? candidate
          : entry.id || entry.url
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id || entry.url)}`
            : "";
        if (!entryUrl) return [];
        const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
        return [{
          url: entryUrl,
          title: entry.title || "Playlist video",
          thumbnail: entry.thumbnail || thumbnails.at(-1)?.url || "",
          duration: entry.duration || 0,
          platform: "YouTube",
          sourceHeight: 0,
          resolutions: [],
          needsAnalysis: true
        }];
      });
      if (!entries.length) throw new Error("This playlist does not contain downloadable public videos.");
      return {
        title: info.title || "YouTube playlist",
        platform: "YouTube Playlist",
        entries
      };
    }
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
    const isInstagram = /(?:^|\.)instagram\.com$/i.test(new URL(url).hostname);
    const standardHeights = (isInstagram ? [] : [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144])
      .filter((height) => height <= maxHeight);
    const isYouTubeMusic = /(?:^|\.)music\.youtube\.com$/i.test(new URL(url).hostname);
    return {
      title: info.title || "Untitled video",
      thumbnail: info.thumbnail || "",
      duration: info.duration || 0,
      platform: isYouTubeMusic ? "YouTube Music" : (info.extractor_key || info.extractor || "Video"),
      isStory: /instagram.*story/i.test(`${info.extractor_key || ""} ${info.webpage_url || url}`),
      resolutions: standardHeights,
      sourceHeight: maxHeight
    };
  } catch (error) {
    if (isPinterestUrl(url)) {
      try { return await pinterestInfo(url); } catch (pinterestError) { throw friendlyError(pinterestError); }
    }
    throw friendlyError(error, url);
  }
});

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: app.getPath("downloads")
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("update-engine", async () => {
  if (activeProcesses.size) {
    throw new Error("Wait for active downloads to finish before updating the engine.");
  }
  await ensureEngine();
  const previousVersion = await videoEngineVersion();
  await refreshVideoEngine();
  const version = await videoEngineVersion();
  return {
    previousVersion,
    version,
    message: previousVersion === version
      ? `Video engine is already current (${version}).`
      : `Video engine updated from ${previousVersion} to ${version}.`
  };
});

ipcMain.handle("app-info", async () => {
  let engineVersion = "Not installed";
  try { engineVersion = await videoEngineVersion(); } catch (_) {}
  return {
    version: app.getVersion(),
    buildDate: "2026-11-09",
    platform: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform,
    architecture: process.arch,
    engineVersion
  };
});

ipcMain.handle("check-app-update", async () => checkForAppUpdate());

ipcMain.handle("download-app-update", async () => {
  if (appUpdateDownloadPromise) return appUpdateDownloadPromise;
  appUpdateDownloadPromise = (async () => {
    const update = await checkForAppUpdate();
    if (!update.updateAvailable) return { downloaded: false, message: "FluxSave is already up to date." };
    if (!update.assetAvailable || !update.assetUrl) {
      throw new Error("This release does not include an installer for this computer.");
    }
    const destination = path.join(app.getPath("downloads"), path.basename(update.assetName));
    await downloadUpdateFile(update.assetUrl, destination);
    const openError = await shell.openPath(destination);
    return {
      downloaded: true,
      path: destination,
      name: path.basename(destination),
      message: openError
        ? `Update downloaded to ${destination}. Open it to install.`
        : "Update downloaded and opened. Replace FluxSave in Applications to finish."
    };
  })();
  try { return await appUpdateDownloadPromise; } finally { appUpdateDownloadPromise = null; }
});

async function saveInstagramSessionCookies(electronSession) {
  const cookies = await electronSession.cookies.get({ url: "https://www.instagram.com" });
  const sessionCookie = cookies.find((cookie) => cookie.name === "sessionid" && cookie.value);
  if (!sessionCookie) return false;
  await fsp.mkdir(engineDir(), { recursive: true });
  const lines = ["# Netscape HTTP Cookie File", "# Stored locally by FluxSave for Instagram downloads."];
  for (const cookie of cookies) {
    const rawDomain = cookie.domain || ".instagram.com";
    const httpOnlyPrefix = cookie.httpOnly ? "#HttpOnly_" : "";
    const domain = `${httpOnlyPrefix}${rawDomain}`;
    const includeSubdomains = rawDomain.startsWith(".") ? "TRUE" : "FALSE";
    const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
    lines.push([domain, includeSubdomains, cookie.path || "/", cookie.secure ? "TRUE" : "FALSE", expires, cookie.name, cookie.value].join("\t"));
  }
  await fsp.writeFile(instagramCookiesPath(), `${lines.join("\n")}\n`, { mode: 0o600 });
  if (!isWindows) await fsp.chmod(instagramCookiesPath(), 0o600);
  return true;
}

ipcMain.handle("instagram-login-status", async () => {
  const instagramSession = session.fromPartition(instagramPartition);
  const cookies = await instagramSession.cookies.get({ url: "https://www.instagram.com" });
  return { connected: cookies.some((cookie) => cookie.name === "sessionid" && cookie.value) && fs.existsSync(instagramCookiesPath()) };
});

ipcMain.handle("instagram-login", async () => {
  const loginWindow = new BrowserWindow({
    width: 520,
    height: 760,
    parent: mainWindow,
    modal: false,
    title: "Sign in to Instagram for FluxSave",
    webPreferences: {
      partition: instagramPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const loginSession = loginWindow.webContents.session;
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await loginWindow.loadURL("https://www.instagram.com/accounts/login/");
  return await new Promise((resolve) => {
    let finished = false;
    const finish = async (closeWhenConnected = false) => {
      if (finished) return;
      let connected = false;
      try { connected = await saveInstagramSessionCookies(loginSession); } catch (_) {}
      if (!connected && closeWhenConnected) return;
      finished = true;
      resolve({ connected, message: connected ? "Instagram session connected." : "Instagram login was not completed." });
      if (connected && !loginWindow.isDestroyed()) loginWindow.close();
    };
    const checkLogin = () => setTimeout(() => finish(true), 700);
    loginWindow.webContents.on("did-navigate", checkLogin);
    loginWindow.webContents.on("did-navigate-in-page", checkLogin);
    loginWindow.on("closed", () => finish(false));
  });
});

ipcMain.handle("download", async (_event, job) => {
  const jobId = String(job.id || `download-${Date.now()}-${Math.random()}`);
  cancelledJobs.delete(jobId);
  const engine = await ensureEngine();
  notifyDesktop("FluxSave download started", job.title || "Preparing your media");
  const folder = job.folder || app.getPath("downloads");
  await fsp.mkdir(folder, { recursive: true });
  const workFolder = await fsp.mkdtemp(path.join(app.getPath("temp"), "fluxsave-"));
  try {
  const template = path.join(workFolder, "%(title).140B.%(ext)s");
  const args = [
    "--ignore-config", "--newline", "--no-playlist", "--no-warnings",
    "--continue", "--part",
    "--buffer-size", "1M",
    "--http-chunk-size", "10M",
    "--retries", "10",
    "--fragment-retries", "20",
    "--file-access-retries", "5",
    "--retry-sleep", "http:exp=1:20",
    "--retry-sleep", "fragment:exp=1:20",
    "--progress-template", "download:fluxsave:%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s",
    ...authenticationArgs(job.auth, job.url),
    "--ffmpeg-location", engine.ffmpeg,
    "-o", template
  ];
  const features = job.features || {};
  if (features.subtitles) {
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", "all,-live_chat", "--embed-subs");
  }
  if (features.metadata) args.push("--embed-metadata", "--embed-chapters");
  if (features.thumbnail) args.push("--embed-thumbnail");
  if (features.sponsorBlock === "mark") {
    args.push("--sponsorblock-mark", "all");
  } else if (features.sponsorBlock === "remove") {
    args.push("--sponsorblock-remove", "all");
  }
  let requiresH264Conversion = false;
  let isInstagramJob = false;
  try { isInstagramJob = /(?:^|\.)instagram\.com$/i.test(new URL(job.url).hostname); } catch (_) {}
  if (job.mode === "audio") {
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", `${job.quality || 320}K`);
  } else {
    const requestedHeight = job.quality === "best"
      ? Number(job.sourceHeight || 0)
      : Number(job.quality);
    requiresH264Conversion = !isInstagramJob && requestedHeight > 1080;
    const h264Mp4Format = `bestvideo[vcodec^=avc1]${job.quality === "best" ? "" : `[height<=${Number(job.quality)}]`}+bestaudio[acodec^=mp4a]/best[vcodec^=avc1][acodec^=mp4a]${job.quality === "best" ? "" : `[height<=${Number(job.quality)}]`}`;
    const format = isInstagramJob
      ? "best[ext=mp4]/best"
      : job.quality === "best"
        ? requiresH264Conversion ? "bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best" : h264Mp4Format
        : !requiresH264Conversion
          ? h264Mp4Format
          : `bestvideo[height<=${Number(job.quality)}]+bestaudio[acodec^=mp4a]/bestvideo[height<=${Number(job.quality)}]+bestaudio/best[height<=${Number(job.quality)}]`;
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
  args.push("--print", "after_move:filepath", "--", job.directUrl || job.url);
  let lastPath = "";
  let output;
  let lastError;
  let previousRawPercent = 0;
  let downloadPass = 0;
  let highestReportedPercent = 0;
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(job.url || "");
  // Media URLs can be rejected with HTTP 403 when a platform's default
  // player client is blocked. Try fresh YouTube clients as a fallback while
  // retaining the normal client first for fastest downloads.
  const clientVariants = isYouTube
    ? [[], ["--extractor-args", "youtube:player_client=web_safari"], ["--extractor-args", "youtube:player_client=android"]]
    : [[]];
  let clientIndex = 0;
  for (const clientArgs of clientVariants) {
    for (const fragmentCount of [16, 8, 4, 1]) {
      if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
      try {
        output = await run(engine.ytdlp, [
          ...clientArgs,
          "--concurrent-fragments", String(fragmentCount),
          ...args
        ], (line) => {
        const match = line.match(/fluxsave:\s*(\d+(?:\.\d+)?)%\|([^|]*)\|(.*)/);
        if (match) {
          const rawPercent = Number(match[1]);
          if (job.mode === "video" && previousRawPercent >= 80 && rawPercent + 40 < previousRawPercent) {
            downloadPass = Math.min(1, downloadPass + 1);
          }
          previousRawPercent = rawPercent;
          let mappedPercent;
          if (job.mode === "audio") {
            mappedPercent = rawPercent * 0.95;
          } else if (isInstagramJob) {
            mappedPercent = rawPercent * 0.98;
          } else if (requiresH264Conversion) {
            mappedPercent = downloadPass === 0 ? rawPercent * 0.60 : 60 + rawPercent * 0.10;
          } else {
            mappedPercent = downloadPass === 0 ? rawPercent * 0.85 : 85 + rawPercent * 0.13;
          }
          highestReportedPercent = Math.max(highestReportedPercent, mappedPercent);
          send("download-progress", {
            jobId,
            percent: highestReportedPercent,
            phase: "download",
            eta: match[2].trim(),
            etaScope: "current part",
            speed: match[3].trim()
          });
        }
        if (/\[Merger\]|Merging formats into|Post-process/i.test(line)) {
          highestReportedPercent = Math.max(highestReportedPercent, requiresH264Conversion ? 69 : 98);
          send("download-progress", { jobId, percent: highestReportedPercent, phase: "finalize", eta: "", speed: "" });
        }
        for (const part of line.trim().split("\n")) {
          if (path.isAbsolute(part.trim())) lastPath = part.trim();
        }
        }, jobId);
        break;
      } catch (error) {
        lastError = error;
        if (cancelledJobs.has(jobId)) throw new Error("Download canceled.");
        const message = String(error?.message || error);
        const forbidden = /403|forbidden|unable to download video data/i.test(message);
        if (fragmentCount !== 1) {
          send("engine-status", "Connection adjusted; resuming download…");
        } else if (forbidden && clientIndex < clientVariants.length - 1) {
          send("engine-status", "Video host rejected the request; trying an alternate player…");
        }
      }
    }
    if (output) break;
    clientIndex += 1;
  }
  send("engine-status", "Ready");
  if (!output) throw friendlyError(lastError, job.url);
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
    notifyDesktop("FluxSave is processing", "Converting to playable H.264 MP4");
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
  notifyDesktop("FluxSave download complete", path.basename(finalPath));
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

function createActivityTray() {
  if (process.platform !== "darwin" || activityTray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
  activityTray = new Tray(icon.resize({ width: 16, height: 16 }));
  activityTray.setTitle(" Ready");
  activityTray.setToolTip("FluxSave: Ready");
  activityTray.setContextMenu(Menu.buildFromTemplate([
    { label: "FluxSave — download activity", enabled: false },
    { type: "separator" },
    { label: "Show FluxSave", click: () => mainWindow?.show() },
    { label: "Quit FluxSave", click: () => app.quit() }
  ]));
}

app.whenReady().then(() => { createActivityTray(); createWindow(); });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
