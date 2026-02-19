#!/bin/bash
# Vafrum Core - Als systemd Service installieren
# Für Raspberry Pi und Linux Server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="vafrum-core"

# Root-Rechte prüfen
if [ "$EUID" -ne 0 ]; then
    echo "Bitte mit sudo ausführen: sudo ./install-service.sh"
    exit 1
fi

# Node.js prüfen
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "FEHLER: Node.js nicht gefunden!"
    echo "Installation: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs"
    exit 1
fi

# node_modules installieren falls nötig
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "Installiere Abhängigkeiten..."
    cd "$SCRIPT_DIR" && npm install --production
fi

# Binaries ausführbar machen
chmod +x "$SCRIPT_DIR/go2rtc" 2>/dev/null
chmod +x "$SCRIPT_DIR/cloudflared" 2>/dev/null

# Prüfen ob config.json existiert
if [ ! -f "$SCRIPT_DIR/config.json" ]; then
    echo ""
    read -p "Bitte API Key eingeben (vfk_...): " API_KEY
    echo "{\"apiKey\": \"$API_KEY\"}" > "$SCRIPT_DIR/config.json"
    echo "Config gespeichert!"
fi

# systemd Service erstellen
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Vafrum Core - Bambu Lab Printer Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_PATH} ${SCRIPT_DIR}/main-headless.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Service aktivieren und starten
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl start ${SERVICE_NAME}

echo ""
echo "========================================="
echo "  Vafrum Core Service installiert!"
echo "========================================="
echo ""
echo "Befehle:"
echo "  Status:    sudo systemctl status ${SERVICE_NAME}"
echo "  Logs:      sudo journalctl -u ${SERVICE_NAME} -f"
echo "  Stoppen:   sudo systemctl stop ${SERVICE_NAME}"
echo "  Starten:   sudo systemctl start ${SERVICE_NAME}"
echo "  Neustart:  sudo systemctl restart ${SERVICE_NAME}"
echo "  Entfernen: sudo systemctl disable ${SERVICE_NAME}"
echo ""
