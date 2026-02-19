#!/bin/bash
# Vafrum Core - Headless Bridge Startskript
# Für Raspberry Pi und Linux Server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Prüfen ob Node.js installiert ist
if ! command -v node &> /dev/null; then
    echo "FEHLER: Node.js ist nicht installiert!"
    echo "Installation: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs"
    exit 1
fi

# Prüfen ob node_modules existiert
if [ ! -d "node_modules" ]; then
    echo "Installiere Abhängigkeiten..."
    npm install --production
fi

# Prüfen ob config.json existiert
if [ ! -f "config.json" ]; then
    echo ""
    echo "========================================="
    echo "  Erste Einrichtung"
    echo "========================================="
    echo ""
    read -p "Bitte API Key eingeben (vfk_...): " API_KEY
    echo "{\"apiKey\": \"$API_KEY\"}" > config.json
    echo "Config gespeichert!"
    echo ""
fi

# go2rtc und cloudflared ausführbar machen
chmod +x go2rtc 2>/dev/null
chmod +x cloudflared 2>/dev/null

echo "Starte Vafrum Core..."
exec node main-headless.js
