---
name: pi-speech-to-text
description: "Transcribe local audio/voice files using ffmpeg and whisper.cpp. Use when the user attaches audio, voice memos, .oga/.ogg/.mp3/.wav files, or asks for speech-to-text/transcription."
---

# Speech to Text

Transcribe local audio files with `ffmpeg` and `whisper-cli`.

Use this whenever the user sends an audio attachment or asks to transcribe a voice memo. Telegram `.oga` voice files are supported.

## Usage

```bash
{baseDir}/speech-to-text.js /path/to/audio.oga
```

Options:

```bash
{baseDir}/speech-to-text.js /path/to/audio.oga --model base
{baseDir}/speech-to-text.js /path/to/audio.oga --model small --timeout 90
{baseDir}/speech-to-text.js /path/to/audio.oga --language auto
{baseDir}/speech-to-text.js /path/to/audio.oga --keep-wav
```

For compatibility with older Pion sessions, this skill also includes:

```bash
{baseDir}/local-transcribe-audio /path/to/audio.oga
```

## Dependencies

Required commands:

```bash
ffmpeg
whisper-cli
```

Default model directory:

```bash
~/.local/share/whisper
```

Known model aliases:

- `base` → `~/.local/share/whisper/ggml-base.bin`
- `small` → `~/.local/share/whisper/ggml-small-q5_1.bin`
- `large` → `~/.local/share/whisper/ggml-large-v3-turbo-q5_0.bin`

You can override paths with:

```bash
WHISPER_MODEL_DIR=/path/to/models
WHISPER_CLI=/path/to/whisper-cli
```

## Notes

- The script always converts audio to 16k mono 16-bit WAV before transcription.
- Output is plain transcript only, suitable to paste into chat context.
- If transcription hangs, use `--model base` or lower `--timeout`.
