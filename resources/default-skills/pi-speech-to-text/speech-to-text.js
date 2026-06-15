#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const modelDir =
  process.env.WHISPER_MODEL_DIR ||
  process.env.PION_WHISPER_MODEL_DIR ||
  join(homedir(), ".local", "share", "whisper");

const MODELS = {
  base: join(modelDir, "ggml-base.bin"),
  small: join(modelDir, "ggml-small-q5_1.bin"),
  large: join(modelDir, "ggml-large-v3-turbo-q5_0.bin"),
};

function usage(code = 0) {
  console.log(`Usage: speech-to-text.js <audio-file> [--model base|small|large|/path/model.bin] [--language auto|en|tr] [--timeout seconds] [--keep-wav]\n\nDefaults: --model base --language auto --timeout 75\n\nEnvironment:\n  WHISPER_MODEL_DIR  Model directory (default: ~/.local/share/whisper)\n  WHISPER_CLI        whisper-cli binary path override`);
  process.exit(code);
}

function which(cmd) {
  const result = spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(0);

const input = args[0];
let modelName = "base";
let language = "auto";
let timeoutSec = 75;
let keepWav = false;

for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--model" || arg === "-m") modelName = args[++i] || modelName;
  else if (arg === "--language" || arg === "-l") language = args[++i] || language;
  else if (arg === "--timeout") timeoutSec = Number(args[++i] || timeoutSec);
  else if (arg === "--keep-wav") keepWav = true;
  else {
    console.error(`Unknown argument: ${arg}`);
    usage(1);
  }
}

if (!input || !existsSync(input)) {
  console.error(`Audio file not found: ${input}`);
  process.exit(1);
}

const ffmpeg = which("ffmpeg");
const whisper = process.env.WHISPER_CLI || which("whisper-cli") || which("whisper-cpp");
if (!ffmpeg) {
  console.error("ffmpeg not found in PATH");
  process.exit(1);
}
if (!whisper || !existsSync(whisper)) {
  console.error("whisper-cli not found in PATH. Install whisper.cpp and ensure whisper-cli is available.");
  process.exit(1);
}

const modelPath = MODELS[modelName] || modelName;
if (!existsSync(modelPath)) {
  console.error(`Whisper model not found: ${modelPath}`);
  console.error("Download a model into ~/.local/share/whisper or set WHISPER_MODEL_DIR.");
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), "pi-stt-"));
const wav = join(workDir, `${basename(input).replace(/[^a-zA-Z0-9._-]/g, "-")}.wav`);

try {
  const convert = spawnSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wav,
  ], { encoding: "utf8" });

  if (convert.status !== 0) {
    console.error(convert.stderr || "ffmpeg conversion failed");
    process.exit(convert.status || 1);
  }

  const transcribe = spawnSync(whisper, [
    "-m",
    modelPath,
    "-l",
    language,
    "-nt",
    "-np",
    wav,
  ], {
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (transcribe.error?.code === "ETIMEDOUT") {
    console.error(`transcription timed out after ${timeoutSec}s using model ${modelName}`);
    process.exit(124);
  }
  if (transcribe.status !== 0) {
    console.error(transcribe.stderr || transcribe.error?.message || "whisper-cli failed");
    process.exit(transcribe.status || 1);
  }

  const text = transcribe.stdout
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  console.log(text);
} finally {
  if (!keepWav) rmSync(workDir, { recursive: true, force: true });
  else console.error(`kept wav: ${wav}`);
}
