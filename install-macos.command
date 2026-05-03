#!/bin/bash
# Vafrum Core – macOS One-Click Installer
# Doppelklick auf diese Datei installiert Vafrum Core automatisch.

set -e

REPO="VafrumAdmin/vafrum-core-client"
APP_NAME="Vafrum Core"

echo ""
echo "====================================="
echo "  Vafrum Core – macOS Installer"
echo "====================================="
echo ""

# Architektur erkennen
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  ASSET="VafrumCore-macOS-arm64.zip"
  echo "Erkannt: Apple Silicon (arm64)"
else
  ASSET="VafrumCore-macOS-x64.zip"
  echo "Erkannt: Intel (x64)"
fi

echo ""

# Neueste Version von GitHub holen
echo "Lade neueste Version herunter..."
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
TMP_ZIP="/tmp/${ASSET}"

curl -L -# -o "$TMP_ZIP" "$DOWNLOAD_URL"

if [ ! -f "$TMP_ZIP" ] || [ ! -s "$TMP_ZIP" ]; then
  echo "Fehler: Download fehlgeschlagen!"
  echo "URL: $DOWNLOAD_URL"
  read -n 1 -s -r -p "Druecke eine Taste zum Beenden..."
  exit 1
fi

echo "Download abgeschlossen."
echo ""

# Alte Installation entfernen
if [ -d "/Applications/${APP_NAME}.app" ]; then
  echo "Entferne alte Version..."
  rm -rf "/Applications/${APP_NAME}.app"
fi

# Entpacken nach /Applications
echo "Installiere nach /Applications..."
ditto -x -k "$TMP_ZIP" /Applications/

# Pruefen ob App existiert
if [ ! -d "/Applications/${APP_NAME}.app" ]; then
  echo "Fehler: App wurde nicht korrekt entpackt!"
  read -n 1 -s -r -p "Druecke eine Taste zum Beenden..."
  exit 1
fi

# Quarantine-Flag entfernen (verhindert Gatekeeper-Warnung)
echo "Entferne Sicherheitssperre..."
xattr -cr "/Applications/${APP_NAME}.app" 2>/dev/null || true

# Aufraeumen
rm -f "$TMP_ZIP"

echo ""
echo "Installation abgeschlossen!"
echo "${APP_NAME} wurde in /Applications installiert."
echo ""
echo "Starte ${APP_NAME}..."
open "/Applications/${APP_NAME}.app"

echo ""
echo "Dieses Fenster kann geschlossen werden."
echo ""
