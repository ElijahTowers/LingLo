#!/usr/bin/env bash
# Sets up Piper TTS for LingLo.
# Piper is a fast, high-quality, fully self-hosted neural TTS engine.
# https://github.com/rhasspy/piper
#
# macOS:        Uses piper-tts Python package (native ARM64 + x86_64 via Rosetta)
#               Requires Python 3.10+ (checks Homebrew, then system Python)
# Linux/Windows: Downloads standalone piper binary (all deps bundled)

set -e

PIPER_DIR="$(cd "$(dirname "$0")" && pwd)/piper"
mkdir -p "$PIPER_DIR"
cd "$PIPER_DIR"

OS="$(uname -s)"

# ── Voice model (same for all platforms) ─────────────────────────────────────
MODEL="es_ES-davefx-medium.onnx"
MODEL_JSON="${MODEL}.json"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium"

if [ ! -f "$MODEL" ]; then
  echo "Downloading Spanish voice model (~65 MB)..."
  curl -L -o "$MODEL"      "${VOICE_BASE}/${MODEL}"
  curl -L -o "$MODEL_JSON" "${VOICE_BASE}/${MODEL_JSON}"
  echo "Voice model installed."
else
  echo "Voice model already present, skipping."
fi

# ── macOS: Python-based piper (native ARM64, no dylib issues) ─────────────────
if [ "$OS" = "Darwin" ]; then
  if [ -f "venv/bin/piper" ]; then
    echo "Python piper already installed, skipping."
  else
    echo "Setting up Piper via Python (macOS)..."

    # Find Python 3.10+
    PYTHON=""
    for candidate in \
      /opt/homebrew/bin/python3.12 \
      /opt/homebrew/bin/python3.11 \
      /opt/homebrew/bin/python3.10 \
      /opt/homebrew/bin/python3 \
      /usr/local/bin/python3.12 \
      /usr/local/bin/python3.11 \
      /usr/local/bin/python3.10 \
      python3.12 python3.11 python3.10; do
      if command -v "$candidate" &>/dev/null; then
        VER=$("$candidate" -c 'import sys; print(sys.version_info[:2] >= (3,10))' 2>/dev/null)
        if [ "$VER" = "True" ]; then
          PYTHON="$candidate"
          break
        fi
      fi
    done

    if [ -z "$PYTHON" ]; then
      echo "ERROR: Python 3.10+ not found. Install with: brew install python3"
      echo "Alternatively, Homebrew itself: https://brew.sh"
      exit 1
    fi

    echo "Using $PYTHON ($(${PYTHON} --version))"
    "$PYTHON" -m venv venv
    ./venv/bin/pip install --quiet piper-tts pathvalidate
    echo "Python piper installed."
  fi

  # Smoke test
  echo "Testing Piper..."
  echo "hola mundo" | ./venv/bin/piper --model "$MODEL" --output-file /tmp/linglo-piper-test.wav 2>/dev/null
  if [ -f /tmp/linglo-piper-test.wav ]; then
    rm /tmp/linglo-piper-test.wav
    echo ""
    echo "✓ Piper is working. Restart LingLo (pm2 restart 8) to enable it."
  else
    echo "Test failed — check output above."
    exit 1
  fi
  exit 0
fi

# ── Linux / Windows: standalone binary ───────────────────────────────────────
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Linux-x86_64)   ASSET="piper_linux_x86_64.tar.gz" ;;
  Linux-aarch64)  ASSET="piper_linux_aarch64.tar.gz" ;;
  Linux-armv7l)   ASSET="piper_linux_armv7l.tar.gz" ;;
  *)
    echo "Unsupported platform: $OS $ARCH"
    echo "Download manually from https://github.com/rhasspy/piper/releases"
    exit 1
    ;;
esac

if [ ! -f "piper" ]; then
  echo "Downloading Piper binary ($ASSET)..."
  LATEST=$(curl -s https://api.github.com/repos/rhasspy/piper/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
  curl -L "https://github.com/rhasspy/piper/releases/download/${LATEST}/${ASSET}" | tar xz --strip-components=1
  chmod +x piper
  echo "Piper binary installed."
else
  echo "Piper binary already present, skipping."
fi

# Smoke test
echo "Testing Piper..."
echo "hola mundo" | ./piper --model "$MODEL" --output_file /tmp/linglo-piper-test.wav --quiet
if [ -f /tmp/linglo-piper-test.wav ]; then
  rm /tmp/linglo-piper-test.wav
  echo ""
  echo "✓ Piper is working. Restart LingLo to enable it."
else
  echo "Test failed — check output above."
  exit 1
fi
